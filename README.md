# PocketPilot

PocketPilot is a Windows-first, self-hosted Agent that lets one user control
Claude Code sessions on their own computer from a mobile client.

PocketPilot provides a standard HTTP and WebSocket interface. It does not run
a relay, configure a tunnel, provision TLS, discover a public address, or
manage Claude credentials. The user owns the connection path and configures
Claude Code on the computer before starting the Agent.

## Requirements

- Windows 11
- Node.js 24 LTS
- pnpm 10.14.x
- Claude Code installed and authenticated for the logged-in Windows user

PocketPilot is a foreground application. It does not install a Windows Service,
create a login task, or start automatically.

## Build and Install

From a source checkout:

```powershell
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

Install the generated tarball. pnpm 10 requires explicit approval for the
`better-sqlite3` native install script:

```powershell
pnpm add -g .\pocketpilot-0.1.0.tgz --allow-build=better-sqlite3
```

The installed package contains the CLI, Drizzle migrations, and the local
administration page under one `dist` tree.

## Master Key

PocketPilot requires a 32-byte, unpadded base64url master key. Generate one:

```powershell
$key = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
$env:AGENT_MASTER_KEY = $key
```

Keep the same key for later starts. Store it using a secret-management method
appropriate for the computer; do not place it in source files, command-line
arguments, screenshots, or logs.

Agent data defaults to `%LOCALAPPDATA%\PocketPilot`. To use a different local
directory, set `POCKETPILOT_DATA_DIR` before every command:

```powershell
$env:POCKETPILOT_DATA_DIR = "D:\PocketPilotData"
```

## Start and Stop

Start PocketPilot manually in the foreground:

```powershell
agent start
```

The default endpoints are:

- Remote HTTP/WebSocket API: `http://127.0.0.1:43182`
- Local administration: `http://127.0.0.1:43183`

Stop it with `Ctrl+C` in its terminal or from another terminal:

```powershell
agent stop
```

Both paths cancel all active Agent tasks and pending approvals before the
process exits. The local administration page never starts or stops the Agent.

## Local Configuration

Open `http://127.0.0.1:43183` on the Agent computer. The page manages:

- Mobile-reachable base URL
- Remote listener host and port
- Authorized workspace roots
- Concurrent task capacity
- Device pairing, approval, and revocation
- Metadata-only audit records

Listener changes apply only after manually stopping and starting the Agent.
The administration page is always bound to `127.0.0.1` and is never mounted on
the remote API listener.

## Connectivity

PocketPilot does not test, create, or operate the connection between the phone
and computer. Configure one of the following paths yourself, then enter its
mobile-reachable base URL in Local Configuration.

### ngrok-style loopback forwarding

Keep the default remote listener at `127.0.0.1:43182`, then point your tunnel at
that address. For example, when using ngrok independently:

```powershell
ngrok http 43182
```

Enter the HTTPS URL shown by ngrok as the mobile base URL. PocketPilot embeds
that exact manually entered URL in newly generated pairing QR codes.

### Tailscale-compatible binding

In Local Configuration, set the remote listener to the computer's Tailscale IP
or to `0.0.0.0`, choose a port, save, and manually restart PocketPilot. Use the
computer's tailnet address as the mobile base URL. Multiple network interfaces
are exposed when `0.0.0.0` is selected, so rely on Windows Firewall and the
chosen network policy to restrict access.

Direct PocketPilot traffic is plain HTTP/WebSocket. A Tailscale tailnet
encrypts its network path; Tailscale Serve or another user-operated TLS
terminator may provide an HTTPS URL. PocketPilot itself does not claim or add
transport encryption.

Do not expose the plain HTTP listener to an untrusted network without an
encrypted and access-controlled connection path.

## Rotate the Master Key

Stop the Agent first. Put the current and replacement keys in separate
environment variables, then run rekey:

```powershell
$env:AGENT_MASTER_KEY = $currentKey
$env:AGENT_NEW_MASTER_KEY = $replacementKey
agent rekey
$env:AGENT_MASTER_KEY = $replacementKey
Remove-Item Env:AGENT_NEW_MASTER_KEY
```

The command validates the current key and atomically re-encrypts every
sensitive Agent record. It refuses to run while the Agent or another
maintenance command owns the data lock.

## Reset After Losing the Key

With the Agent stopped, explicitly confirm reset:

```powershell
agent reset --confirm RESET_AGENT_DATA
```

Reset removes PocketPilot settings, devices, credentials, task metadata,
audits, and transient events. It does not read or delete Claude Code
credentials, configuration, conversation sessions, or project files. Generate
a new `AGENT_MASTER_KEY` before starting PocketPilot again.

## Development

The local administration workspace is in `apps/local-admin`. Use
`pnpm dev:admin` for UI-only development. The production Agent serves the Vite
build only from its localhost Fastify listener.

Run the complete Windows tarball installation and lifecycle smoke test with:

```powershell
pnpm test:release:windows
```
