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

function Write-PocketPilotEnvironmentFile(
  [string]$MasterKey,
  [string]$NewMasterKey = ""
) {
  $lines = @(
    "POCKETPILOT_DATA_DIR=$script:dataDirectory",
    "POCKETPILOT_LOCAL_ADMIN_PORT=$script:localAdminPort"
  )
  if ($MasterKey -ne "") {
    $lines = @("AGENT_MASTER_KEY=$MasterKey") + $lines
  }
  if ($NewMasterKey -ne "") {
    $lines += "AGENT_NEW_MASTER_KEY=$NewMasterKey"
  }
  $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllLines(
    (Join-Path $script:installDirectory ".env"),
    $lines,
    $utf8WithoutBom
  )
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
  Write-PocketPilotEnvironmentFile $MasterKey
  $previousDataDirectory = $env:POCKETPILOT_DATA_DIR
  $previousMasterKey = $env:AGENT_MASTER_KEY
  $previousNewMasterKey = $env:AGENT_NEW_MASTER_KEY
  $previousLocalAdminPort = $env:POCKETPILOT_LOCAL_ADMIN_PORT
  try {
    Remove-Item Env:POCKETPILOT_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_MASTER_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_NEW_MASTER_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:POCKETPILOT_LOCAL_ADMIN_PORT -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $node `
      -ArgumentList @($script:agentCli, "start") `
      -PassThru `
      -RedirectStandardError $stderr `
      -RedirectStandardOutput $stdout `
      -WorkingDirectory $installDirectory `
      -WindowStyle Hidden
    $process | Add-Member -NotePropertyName PocketPilotStderr -NotePropertyValue $stderr
  } finally {
    $env:POCKETPILOT_DATA_DIR = $previousDataDirectory
    $env:AGENT_MASTER_KEY = $previousMasterKey
    $env:AGENT_NEW_MASTER_KEY = $previousNewMasterKey
    $env:POCKETPILOT_LOCAL_ADMIN_PORT = $previousLocalAdminPort
  }
  Wait-HttpOk $HealthUrl $process
  return $process
}

function Stop-PackagedAgent([Diagnostics.Process]$Process) {
  $previousDataDirectory = $env:POCKETPILOT_DATA_DIR
  $previousMasterKey = $env:AGENT_MASTER_KEY
  $previousNewMasterKey = $env:AGENT_NEW_MASTER_KEY
  $previousLocalAdminPort = $env:POCKETPILOT_LOCAL_ADMIN_PORT
  try {
    Remove-Item Env:POCKETPILOT_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_MASTER_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_NEW_MASTER_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:POCKETPILOT_LOCAL_ADMIN_PORT -ErrorAction SilentlyContinue
    Push-Location $installDirectory
    try {
      & $node $script:agentCli stop
      if ($LASTEXITCODE -ne 0) {
        throw "agent stop failed with exit code $LASTEXITCODE."
      }
    } finally {
      Pop-Location
    }
  } finally {
    $env:POCKETPILOT_DATA_DIR = $previousDataDirectory
    $env:AGENT_MASTER_KEY = $previousMasterKey
    $env:AGENT_NEW_MASTER_KEY = $previousNewMasterKey
    $env:POCKETPILOT_LOCAL_ADMIN_PORT = $previousLocalAdminPort
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
  Write-PocketPilotEnvironmentFile $CurrentKey $NewKey
  $previousDataDirectory = $env:POCKETPILOT_DATA_DIR
  $previousMasterKey = $env:AGENT_MASTER_KEY
  $previousNewMasterKey = $env:AGENT_NEW_MASTER_KEY
  $previousLocalAdminPort = $env:POCKETPILOT_LOCAL_ADMIN_PORT
  try {
    Remove-Item Env:POCKETPILOT_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_MASTER_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_NEW_MASTER_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:POCKETPILOT_LOCAL_ADMIN_PORT -ErrorAction SilentlyContinue
    Push-Location $installDirectory
    try {
      & $node $script:agentCli @Arguments
      if ($LASTEXITCODE -ne 0) {
        throw "agent $($Arguments[0]) failed with exit code $LASTEXITCODE."
      }
    } finally {
      Pop-Location
    }
  } finally {
    $env:POCKETPILOT_DATA_DIR = $previousDataDirectory
    $env:AGENT_MASTER_KEY = $previousMasterKey
    $env:AGENT_NEW_MASTER_KEY = $previousNewMasterKey
    $env:POCKETPILOT_LOCAL_ADMIN_PORT = $previousLocalAdminPort
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
  $openApiArtifactPath = Join-Path $installDirectory `
    "node_modules/pocketpilot/dist/openapi/mobile-v1.json"
  if (-not (Test-Path -LiteralPath $openApiArtifactPath)) {
    throw "The installed package does not contain the mobile OpenAPI document."
  }
  $dotenvExamplePath = Join-Path $installDirectory `
    "node_modules/pocketpilot/.env.example"
  if (-not (Test-Path -LiteralPath $dotenvExamplePath)) {
    throw "The installed package does not contain .env.example."
  }

  $oldMasterKey = New-MasterKey
  $newMasterKey = New-MasterKey
  $resetMasterKey = New-MasterKey
  $script:localAdminPort = Get-FreeTcpPort
  while ($localAdminPort -in @(43182, 43183)) {
    $script:localAdminPort = Get-FreeTcpPort
  }
  $remotePort = Get-FreeTcpPort
  while ($remotePort -in @(43182, 43183, $localAdminPort)) {
    $remotePort = Get-FreeTcpPort
  }

  $agentProcess = Start-PackagedAgent $oldMasterKey "http://127.0.0.1:43182/healthz"
  $localBaseUrl = "http://127.0.0.1:$localAdminPort"
  $localPage = Invoke-WebRequest -UseBasicParsing "$localBaseUrl/"
  if (-not $localPage.Content.Contains('<div id="root"></div>')) {
    throw "The packaged local administration page is missing."
  }
  $swaggerPage = Invoke-WebRequest -UseBasicParsing `
    "$localBaseUrl/documentation/"
  if (-not $swaggerPage.Content.Contains("Swagger UI")) {
    throw "The packaged local Swagger UI is missing."
  }
  $runtimeOpenApi = Invoke-RestMethod "$localBaseUrl/documentation/json"
  $artifactOpenApi = Get-Content -Raw $openApiArtifactPath | ConvertFrom-Json
  $runtimeOpenApiJson = $runtimeOpenApi | ConvertTo-Json -Depth 100 -Compress
  $artifactOpenApiJson = $artifactOpenApi | ConvertTo-Json -Depth 100 -Compress
  if ($runtimeOpenApiJson -ne $artifactOpenApiJson) {
    throw "The packaged and runtime OpenAPI documents differ."
  }
  $initialStatus = Invoke-RestMethod "$localBaseUrl/admin/status"
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
  try {
    Invoke-WebRequest -UseBasicParsing `
      "http://127.0.0.1:43182/documentation/json" | Out-Null
    throw "The remote listener exposed the API documentation."
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -ne 404) {
      throw
    }
  }

  $csrf = Invoke-RestMethod "$localBaseUrl/admin/csrf"
  $origin = $localBaseUrl
  $runtimeSettings = @{
    mobileBaseUrl = "https://example.ngrok.app"
    remoteListener = @{ host = "0.0.0.0"; port = $remotePort }
  } | ConvertTo-Json -Depth 4
  Invoke-RestMethod -Method Put `
    -Uri "$localBaseUrl/admin/configuration/runtime" `
    -Headers @{ Origin = $origin; "x-pocketpilot-csrf-token" = $csrf.token } `
    -ContentType "application/json" `
    -Body $runtimeSettings | Out-Null
  Stop-PackagedAgent $agentProcess

  $agentProcess = Start-PackagedAgent $oldMasterKey "http://127.0.0.1:$remotePort/healthz"
  $configuredStatus = Invoke-RestMethod "$localBaseUrl/admin/status"
  if ($configuredStatus.remoteListener.host -ne "0.0.0.0") {
    throw "The non-loopback listener setting was not applied on restart."
  }
  $csrf = Invoke-RestMethod "$localBaseUrl/admin/csrf"
  $pairing = Invoke-RestMethod -Method Post `
    -Uri "$localBaseUrl/admin/pairings" `
    -Headers @{ Origin = $origin; "x-pocketpilot-csrf-token" = $csrf.token } `
    -ContentType "application/json" `
    -Body "{}"
  if ($pairing.qrPayload.baseUrl -ne "https://example.ngrok.app") {
    throw "The pairing QR did not use the manually configured base URL."
  }
  Stop-PackagedAgent $agentProcess

  Invoke-MaintenanceCommand @("rekey") $oldMasterKey $newMasterKey

  Write-PocketPilotEnvironmentFile $oldMasterKey
  $previousDataDirectory = $env:POCKETPILOT_DATA_DIR
  $previousMasterKey = $env:AGENT_MASTER_KEY
  $previousNewMasterKey = $env:AGENT_NEW_MASTER_KEY
  $previousLocalAdminPort = $env:POCKETPILOT_LOCAL_ADMIN_PORT
  try {
    Remove-Item Env:POCKETPILOT_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_MASTER_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_NEW_MASTER_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:POCKETPILOT_LOCAL_ADMIN_PORT -ErrorAction SilentlyContinue
    $wrongKeyProcess = Start-Process -FilePath $node `
      -ArgumentList @($script:agentCli, "start") `
      -PassThru `
      -RedirectStandardError (Join-Path $temporaryRoot "wrong-key.stderr.log") `
      -RedirectStandardOutput (Join-Path $temporaryRoot "wrong-key.stdout.log") `
      -WorkingDirectory $installDirectory `
      -WindowStyle Hidden
  } finally {
    $env:POCKETPILOT_DATA_DIR = $previousDataDirectory
    $env:AGENT_MASTER_KEY = $previousMasterKey
    $env:AGENT_NEW_MASTER_KEY = $previousNewMasterKey
    $env:POCKETPILOT_LOCAL_ADMIN_PORT = $previousLocalAdminPort
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
