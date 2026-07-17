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

The installed package contains the CLI, Drizzle migrations, the local
administration page, and `dist/openapi/mobile-v1.json` under one `dist` tree.

## Startup Environment

PocketPilot requires a 32-byte, unpadded base64url master key. Generate one:

```powershell
$key = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Create a dedicated launch directory, copy `.env.example` into it as `.env`, and
set the generated key:

```dotenv
AGENT_MASTER_KEY=<generated-key>
POCKETPILOT_DATA_DIR=D:\PocketPilotData
POCKETPILOT_LOCAL_ADMIN_PORT=43183
```

Run every `agent` command from that directory. PocketPilot reads only the exact
`.env` in its startup working directory; it does not search parent directories
or the Agent data directory. A missing file is allowed when the required values
are supplied through the process environment.

Existing process-environment values override `.env`. The dotenv allowlist is:

- `AGENT_MASTER_KEY`
- `AGENT_NEW_MASTER_KEY` for `agent rekey` only
- `POCKETPILOT_DATA_DIR`
- `POCKETPILOT_LOCAL_ADMIN_PORT`

Other `.env` keys are ignored. PocketPilot does not load `ANTHROPIC_*` or other
Claude credentials from this file; Claude configuration remains owned by the
locally configured Claude Agent SDK.

Keep the same master key for later starts. `.env` contains plaintext secrets,
so protect it with Windows account permissions and never commit, share,
screenshot, or log it. The repository ignores `.env` and `.env.*` while
allowing the secret-free `.env.example`.

Agent data defaults to `%LOCALAPPDATA%\PocketPilot`. To use a different local
directory without placing it in `.env`, set `POCKETPILOT_DATA_DIR` before each
command:

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

`POCKETPILOT_LOCAL_ADMIN_PORT` changes only the loopback administration port.
It must be an integer from `1` through `65535`, is applied at the next manual
start, and never makes the administration listener non-loopback.

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

## Mobile API Documentation

With the Agent running, open the local Swagger UI at:

```text
http://127.0.0.1:43183/documentation/
```

The raw OpenAPI 3.1 document is available locally at
`/documentation/json`. A matching build artifact ships at
`dist/openapi/mobile-v1.json` for sharing or mobile-client code generation.
When `POCKETPILOT_LOCAL_ADMIN_PORT` changes, use that port in the local URL.

The document contains only the remote `/v1` mobile contract. It excludes local
`/admin/*` and `/_internal/*` routes, and the remote listener returns 404 for
all documentation URLs. Protected operations use the opaque access credential
as a Bearer token.

The OpenAPI `x-websocket` extensions describe two isolated protocols:
`/v1/tasks/{taskId}/sdk` exchanges raw `SDKUserMessage` and `SDKMessage`
objects owned by `@anthropic-ai/claude-agent-sdk@0.3.210`, while `/v1/events`
carries only PocketPilot task and approval controls. SDK reconnect uses the
optional `afterUuid` query parameter; the control stream retains its
subscription cursor. Swagger UI displays these protocols but does not execute
WebSocket messages.

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

Stop the Agent first. Run from the directory containing the current `.env`, put
the replacement key in a temporary process variable, then run rekey:

```powershell
$env:AGENT_NEW_MASTER_KEY = $replacementKey
agent rekey
Remove-Item Env:AGENT_NEW_MASTER_KEY
```

The command validates the current key and atomically re-encrypts every
sensitive Agent record. It refuses to run while the Agent or another
maintenance command owns the data lock. After it succeeds, replace
`AGENT_MASTER_KEY` in `.env` with the replacement key and ensure no
`AGENT_NEW_MASTER_KEY` entry remains.

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
