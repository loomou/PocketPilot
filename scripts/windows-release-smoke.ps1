$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "The PocketPilot release smoke test requires Windows."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$pnpm = (Get-Command pnpm.cmd).Source
$nodeMajor = & $node -p "process.versions.node.split('.')[0]"
$pnpmVersion = & $pnpm --version
$pnpmStore = & $pnpm store path

if ($nodeMajor -ne "24") {
  throw "The release smoke test requires Node.js 24."
}
if (-not $pnpmVersion.StartsWith("10.14.")) {
  throw "The release smoke test requires pnpm 10.14.x."
}

$temporaryRoot = Join-Path (Split-Path -Parent $pnpmStore) (
  "pocketpilot-release-smoke-{0}" -f [guid]::NewGuid().ToString("N")
)
$packDirectory = Join-Path $temporaryRoot "pack"
$installDirectory = Join-Path $temporaryRoot "install"
$dataDirectory = Join-Path $temporaryRoot "data"
$agentProcess = $null
$outputIndex = 0

function New-MasterKey {
  $bytes = [byte[]]::new(32)
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $random.GetBytes($bytes)
  } finally {
    $random.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Get-FreeTcpPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Get-PocketPilotStartupSnapshot {
  $services = @(
    Get-Service -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "PocketPilot*" } |
      Select-Object -ExpandProperty Name |
      Sort-Object
  )
  $runValue = (
    Get-ItemProperty `
      -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
      -Name "PocketPilot" `
      -ErrorAction SilentlyContinue
  ).PocketPilot
  $startupDirectory = Join-Path $env:APPDATA `
    "Microsoft\Windows\Start Menu\Programs\Startup"
  $startupFiles = @(
    Get-ChildItem -LiteralPath $startupDirectory -Filter "PocketPilot*" `
      -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty Name |
      Sort-Object
  )
  $scheduledTasks = @()
  if ($null -ne (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    $scheduledTasks = @(
      Get-ScheduledTask -TaskName "PocketPilot*" -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty TaskName |
        Sort-Object
    )
  }
  return @{
    runValue = $runValue
    scheduledTasks = $scheduledTasks
    services = $services
    startupFiles = $startupFiles
  } | ConvertTo-Json -Compress
}

function Wait-HttpOk([string]$Url, [Diagnostics.Process]$Process) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if ($Process.HasExited) {
      $details = ""
      if ($null -ne $Process.PocketPilotStderr -and (Test-Path $Process.PocketPilotStderr)) {
        $details = (Get-Content -Raw $Process.PocketPilotStderr).Trim()
      }
      throw "The packaged Agent exited before $Url became available. $details"
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing $Url
      if ($response.StatusCode -eq 200) {
        return
      }
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
  throw "Timed out waiting for $Url."
}

function Start-PackagedAgent([string]$MasterKey, [string]$HealthUrl) {
  $script:outputIndex += 1
  $stdout = Join-Path $temporaryRoot "agent-$script:outputIndex.stdout.log"
  $stderr = Join-Path $temporaryRoot "agent-$script:outputIndex.stderr.log"
  $previousDataDirectory = $env:POCKETPILOT_DATA_DIR
  $previousMasterKey = $env:AGENT_MASTER_KEY
  try {
    $env:POCKETPILOT_DATA_DIR = $dataDirectory
    $env:AGENT_MASTER_KEY = $MasterKey
    $process = Start-Process -FilePath $node `
      -ArgumentList @($script:agentCli, "start") `
      -PassThru `
      -RedirectStandardError $stderr `
      -RedirectStandardOutput $stdout `
      -WindowStyle Hidden
    $process | Add-Member -NotePropertyName PocketPilotStderr -NotePropertyValue $stderr
  } finally {
    $env:POCKETPILOT_DATA_DIR = $previousDataDirectory
    $env:AGENT_MASTER_KEY = $previousMasterKey
  }
  Wait-HttpOk $HealthUrl $process
  return $process
}

function Stop-PackagedAgent([Diagnostics.Process]$Process) {
  $previousDataDirectory = $env:POCKETPILOT_DATA_DIR
  try {
    $env:POCKETPILOT_DATA_DIR = $dataDirectory
    & $node $script:agentCli stop
    if ($LASTEXITCODE -ne 0) {
      throw "agent stop failed with exit code $LASTEXITCODE."
    }
  } finally {
    $env:POCKETPILOT_DATA_DIR = $previousDataDirectory
  }
  if (-not $Process.WaitForExit(10000)) {
    throw "The packaged Agent did not stop within ten seconds."
  }
  $script:agentProcess = $null
}

function Invoke-MaintenanceCommand(
  [string[]]$Arguments,
  [string]$CurrentKey,
  [string]$NewKey = ""
) {
  $previousDataDirectory = $env:POCKETPILOT_DATA_DIR
  $previousMasterKey = $env:AGENT_MASTER_KEY
  $previousNewMasterKey = $env:AGENT_NEW_MASTER_KEY
  try {
    $env:POCKETPILOT_DATA_DIR = $dataDirectory
    $env:AGENT_MASTER_KEY = $CurrentKey
    if ($NewKey -eq "") {
      Remove-Item Env:AGENT_NEW_MASTER_KEY -ErrorAction SilentlyContinue
    } else {
      $env:AGENT_NEW_MASTER_KEY = $NewKey
    }
    & $node $script:agentCli @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "agent $($Arguments[0]) failed with exit code $LASTEXITCODE."
    }
  } finally {
    $env:POCKETPILOT_DATA_DIR = $previousDataDirectory
    $env:AGENT_MASTER_KEY = $previousMasterKey
    $env:AGENT_NEW_MASTER_KEY = $previousNewMasterKey
  }
}

New-Item -ItemType Directory -Path $packDirectory, $installDirectory | Out-Null
$startupSnapshotBefore = Get-PocketPilotStartupSnapshot

try {
  Push-Location $projectRoot
  try {
    & $pnpm pack --pack-destination $packDirectory | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm pack failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }

  $tarballs = @(Get-ChildItem -LiteralPath $packDirectory -Filter "*.tgz")
  if ($tarballs.Count -ne 1) {
    throw "Expected exactly one packed tarball."
  }
  $tarball = $tarballs[0]
  $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText(
    (Join-Path $installDirectory "package.json"),
    '{"name":"pocketpilot-release-smoke","private":true}',
    $utf8WithoutBom
  )

  Push-Location $installDirectory
  try {
    & $pnpm add $tarball.FullName `
      --store-dir $pnpmStore `
      --allow-build=better-sqlite3 | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "Installing the packed Agent failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }

  $script:agentCli = Join-Path $installDirectory "node_modules/pocketpilot/dist/cli.js"
  if (-not (Test-Path -LiteralPath $script:agentCli)) {
    throw "The installed package does not contain dist/cli.js."
  }

  $oldMasterKey = New-MasterKey
  $newMasterKey = New-MasterKey
  $resetMasterKey = New-MasterKey
  $remotePort = Get-FreeTcpPort
  while ($remotePort -in @(43182, 43183)) {
    $remotePort = Get-FreeTcpPort
  }

  $agentProcess = Start-PackagedAgent $oldMasterKey "http://127.0.0.1:43182/healthz"
  $localPage = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:43183/"
  if (-not $localPage.Content.Contains('<div id="root"></div>')) {
    throw "The packaged local administration page is missing."
  }
  $initialStatus = Invoke-RestMethod "http://127.0.0.1:43183/admin/status"
  if ($initialStatus.remoteListener.host -ne "127.0.0.1") {
    throw "The fresh remote listener is not loopback-only."
  }
  try {
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:43182/admin/status" | Out-Null
    throw "The remote listener exposed the local administration API."
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -ne 404) {
      throw
    }
  }

  $csrf = Invoke-RestMethod "http://127.0.0.1:43183/admin/csrf"
  $origin = "http://127.0.0.1:43183"
  $runtimeSettings = @{
    mobileBaseUrl = "https://example.ngrok.app"
    remoteListener = @{ host = "0.0.0.0"; port = $remotePort }
  } | ConvertTo-Json -Depth 4
  Invoke-RestMethod -Method Put `
    -Uri "http://127.0.0.1:43183/admin/configuration/runtime" `
    -Headers @{ Origin = $origin; "x-pocketpilot-csrf-token" = $csrf.token } `
    -ContentType "application/json" `
    -Body $runtimeSettings | Out-Null
  Stop-PackagedAgent $agentProcess

  $agentProcess = Start-PackagedAgent $oldMasterKey "http://127.0.0.1:$remotePort/healthz"
  $configuredStatus = Invoke-RestMethod "http://127.0.0.1:43183/admin/status"
  if ($configuredStatus.remoteListener.host -ne "0.0.0.0") {
    throw "The non-loopback listener setting was not applied on restart."
  }
  $csrf = Invoke-RestMethod "http://127.0.0.1:43183/admin/csrf"
  $pairing = Invoke-RestMethod -Method Post `
    -Uri "http://127.0.0.1:43183/admin/pairings" `
    -Headers @{ Origin = $origin; "x-pocketpilot-csrf-token" = $csrf.token } `
    -ContentType "application/json" `
    -Body "{}"
  if ($pairing.qrPayload.baseUrl -ne "https://example.ngrok.app") {
    throw "The pairing QR did not use the manually configured base URL."
  }
  Stop-PackagedAgent $agentProcess

  Invoke-MaintenanceCommand @("rekey") $oldMasterKey $newMasterKey

  $previousDataDirectory = $env:POCKETPILOT_DATA_DIR
  $previousMasterKey = $env:AGENT_MASTER_KEY
  try {
    $env:AGENT_MASTER_KEY = $oldMasterKey
    $env:POCKETPILOT_DATA_DIR = $dataDirectory
    $wrongKeyProcess = Start-Process -FilePath $node `
      -ArgumentList @($script:agentCli, "start") `
      -PassThru `
      -RedirectStandardError (Join-Path $temporaryRoot "wrong-key.stderr.log") `
      -RedirectStandardOutput (Join-Path $temporaryRoot "wrong-key.stdout.log") `
      -WindowStyle Hidden
  } finally {
    $env:AGENT_MASTER_KEY = $previousMasterKey
    $env:POCKETPILOT_DATA_DIR = $previousDataDirectory
  }
  if (-not $wrongKeyProcess.WaitForExit(10000) -or $wrongKeyProcess.ExitCode -eq 0) {
    if (-not $wrongKeyProcess.HasExited) {
      $wrongKeyProcess.Kill()
    }
    throw "The old master key was accepted after rekey."
  }

  $agentProcess = Start-PackagedAgent $newMasterKey "http://127.0.0.1:$remotePort/healthz"
  Stop-PackagedAgent $agentProcess

  Invoke-MaintenanceCommand @("reset", "--confirm", "RESET_AGENT_DATA") ""
  $agentProcess = Start-PackagedAgent $resetMasterKey "http://127.0.0.1:43182/healthz"
  Stop-PackagedAgent $agentProcess

  if ((Get-PocketPilotStartupSnapshot) -ne $startupSnapshotBefore) {
    throw "Installing or running PocketPilot changed Windows automatic-start state."
  }

  Write-Host "Windows release smoke test passed."
} finally {
  if ($null -ne $agentProcess -and -not $agentProcess.HasExited) {
    $agentProcess.Kill()
    $agentProcess.WaitForExit()
  }
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
