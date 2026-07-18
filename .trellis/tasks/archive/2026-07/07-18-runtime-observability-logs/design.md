# Technical Design

## Architecture

Add a small logging boundary under `src/logging/`:

- `logger.ts` defines the `PocketPilotLogger` interface, safe primitive field
  types, level filtering, child context, and event helpers.
- `terminal-logger.ts` adapts the configured logger record to the approved
  foreground format. It writes to the process diagnostic stream, uses local
  timestamps, aligns metadata on following lines, abbreviates UUID-like IDs,
  and applies level colors only when the destination is an interactive TTY and
  `NO_COLOR` is absent.
- `configuration.ts` reads `POCKETPILOT_LOG_LEVEL` with the existing bootstrap
  environment loader. `info` is the default; `debug`, `warn`, and `error` are
  the other valid values. Invalid values fail before a listener binds.

Use Pino as the record/level engine and keep Fastify's built-in request logger
disabled. Pino is already present transitively through Fastify; declare the
direct dependency so the logger contract is explicit. A small terminal stream
is still needed because the default Pino JSON presentation does not meet the
operator-approved colored layout. The public wrapper accepts only primitive
safe fields and prevents callers from passing arbitrary payload objects.

The logger is created once by `runStartCommand` after dotenv loading and is
passed through `AgentRuntime` into the service and route factories. Unit tests
can inject a capture destination/logger; components that are constructed in
isolation retain a no-op default so existing test fixtures do not need to log.

## Record Contract

Every record contains an internal stable `event` name, a human `msg` title,
level, timestamp, and only explicitly supplied safe fields. Event names use
lowercase dot-separated identifiers, for example:

| Area | Events |
| --- | --- |
| Runtime | `runtime.starting`, `runtime.storage.ready`, `runtime.listener.started`, `runtime.started`, `runtime.shutdown.requested`, `runtime.stopped`, `runtime.start.failed` |
| Pairing/auth | `pairing.created`, `pairing.device.registered`, `pairing.approval.pending`, `pairing.approved`, `pairing.claim.challenge-created`, `pairing.claim.completed`, `auth.request.rejected`, `auth.access.authenticated`, `device.revoked` |
| Transport | `http.request.completed`, `websocket.control.connected`, `websocket.control.closed`, `websocket.sdk.connected`, `websocket.sdk.closed`, `websocket.message.rejected` |
| Task/SDK | `task.created`, `task.attached`, `task.state.changed`, `task.activation.started`, `task.activation.completed`, `task.approval.requested`, `task.approval.resolved`, `task.control.completed`, `sdk.query.started`, `sdk.message.observed`, `sdk.query.result`, `sdk.query.failed`, `task.shutdown.completed` |

The exact event catalog is centralized as constants or typed helpers so route
and service code cannot accidentally use request text as an event name.

## Safe Fields and Redaction

The wrapper accepts strings, numbers, booleans, and null only. It rejects or
omits object/array values, strips line breaks from titles, and truncates long
scalar values before formatting. A defensive Pino redaction list covers token,
secret, proof, signature, authorization, verification-code, prompt, content,
input, output, tool-input/output, API-key, master-key, settings, and environment
field names. Instrumentation never passes those fields in the first place.

Allowed correlation fields include abbreviated `pairingId`, `deviceId`,
`taskId`, `requestId`, listener kind, route template, HTTP method/status,
WebSocket close code, operation name, result/code, SDK message type, UUID
presence, and byte/count metadata. Workspace paths, model configuration, SDK
payloads, credentials, and raw error messages are excluded. Errors log a safe
class/code and optionally a stack frame summary without the error message.

## Integration Boundaries

1. `AgentRuntime` logs startup milestones and failure cleanup, passes child
   loggers to `DeviceAuthService`, `TaskManager`, and both app factories, and
   logs coordinated shutdown milestones. It emits remote health and local
   administration endpoints as separate ready records. A runtime option derived
   from the `.ts` source entrypoint adds the local Swagger endpoint only for
   `pnpm dev`; bundled `.js` execution omits that line.
2. `createHttpApp` keeps `logger: false` and installs an optional response hook
   that emits only debug request metadata. Auth/task error handlers receive the
   logger and emit warn/error records with route-safe IDs and stable codes.
3. `DeviceAuthService` logs successful pairing/approval/claim/refresh/revoke
   transitions. Authentication successes are debug-only; rejected auth is
   logged by the route/error boundary without credentials.
4. Remote and local WebSocket routes log handshake result, subscription or SDK
   activation, invalid frame/close code, and cleanup. They never serialize a
   socket frame into a log record.
5. `TaskManager` logs task creation/attachment, state changes, controls,
   approval transitions, SDK Query start/result/failure, safe message metadata,
   and shutdown. It does not alter event journal payloads or task behavior.

## Configuration and Output

Add `POCKETPILOT_LOG_LEVEL` to the dotenv allowlist and `.env.example`; update
README startup/troubleshooting instructions. The logger writes to stderr so
existing command output remains stable on stdout. TTY detection and
`NO_COLOR` control ANSI output. No log file, database table, browser route, or
mobile endpoint is added.

## Compatibility and Rollback

- HTTP, WebSocket, SDK, task, pairing, audit, and storage schemas are unchanged.
- Logger options remain optional at component boundaries, preserving direct
  unit construction and app-injection tests.
- If logger initialization fails or the level is invalid, startup stops before
  listeners bind and reports the stable configuration error through the CLI.
- Rollback is limited to removing logger wiring and the new environment key;
  no data migration is required.
