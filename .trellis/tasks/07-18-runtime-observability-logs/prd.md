# Runtime and Pairing Diagnostic Logs

## Goal

Make a foreground PocketPilot run diagnosable from its runtime output. An
operator must be able to determine whether startup, local approval, credential
claim, WebSocket authentication, task admission, or Claude SDK activation has
progressed or failed, without exposing credentials or conversation content.

## Background and Confirmed Facts

- `src/http/create-http-app.ts` creates Fastify applications with
  `logger: false`, so HTTP requests and route failures are currently silent.
- `src/runtime/agent-runtime.ts` owns storage initialization, both listeners,
  and coordinated shutdown; only the two listener URLs are printed by
  `src/runtime/commands.ts` after startup.
- Pairing has separate registration, local approval, claim-challenge, and claim
  operations in `src/auth/device-auth-service.ts`. A claim before approval
  raises `PAIRING_NOT_APPROVED`, but there is no lifecycle record explaining
  which step was reached.
- `/v1/events` and `/v1/tasks/:taskId/sdk` authenticate during WebSocket
  handshakes and close with stable codes, but the authentication, subscription,
  activation, message acceptance, and cleanup paths do not emit diagnostics.
- `TaskManager` owns task state, SDK session activation, controls, approvals,
  and shutdown. Existing audit records are metadata-only and are not a runtime
  log stream.
- Backend logging guidance requires stable structured event names and allows
  timestamp, task ID, device ID, listener kind, operation, and result. It
  forbids master keys, tokens, proofs, authorization headers, prompts, Claude
  configuration, SDK message content, tool input/output, and full settings.
- PocketPilot is documented as a foreground application, so the first useful
  diagnostic surface is the process output visible while `agent start` is
  running.
- The MVP writes structured records only to the foreground process output. It
  does not create log files or expose logs over the local or remote APIs.
- The default output is human-readable structured text rather than JSON Lines.
  Each record presents a concise title followed by aligned safe key/value
  fields while retaining stable internal event names.
- Interactive terminals use ANSI color cues: `DEBUG` cyan, `INFO` green,
  `WARN` yellow, `ERROR` red, and secondary metadata dimmed. Color is disabled
  automatically when output is redirected and when the standard `NO_COLOR`
  convention is present.
- The operator-approved presentation is the aligned terminal format shown in
  this task discussion: local timestamp, colored level, concise title, and
  indented safe metadata fields. JSON is not the default presentation.

## Requirements

### R1. Shared structured logger

Introduce one backend logger abstraction used by runtime, auth, HTTP/WebSocket
routes, and task/SDK orchestration. Every record has a stable event name, level,
timestamp, and safe structured fields. Callers must not construct log records
from raw request bodies or SDK messages.

The terminal formatter must optimize for operator scanning: readable local
timestamps, colored level labels in interactive terminals, concise event
titles, aligned fields, and stable machine-searchable event names. ANSI escape
codes must not be emitted to non-TTY destinations.

### R2. Startup and shutdown visibility

Log safe lifecycle milestones and failures for master-key validation, storage
open/migration, runtime recovery, local and remote listener binding, control
state creation, shutdown request, listener close, task shutdown, storage close,
and lock release. Startup failures must include a stable failure event and
error code/class without logging secret values.

After successful startup, print the remote health URL and local administration
URL as two separate `info` records in both source-development and built
production execution. Source-development execution also prints the local
Swagger UI URL as its own `info` record; built production execution does not
print the Swagger line.

### R3. Pairing and authentication visibility

Log pairing creation, device registration, pending approval lookup, local
approval success/failure, claim challenge creation, claim success/failure,
access authentication success/failure, refresh/revocation, and device socket
registration/cleanup. Use opaque IDs and safe result/error codes only; never log
verification codes, credentials, signatures, proofs, or authorization headers.

### R4. Transport visibility

Log accepted/rejected HTTP requests and WebSocket lifecycle transitions for the
remote listener, including route/listener kind, status or close code, device ID
when authenticated, task ID where applicable, and safe failure reason. Do not
enable unfiltered Fastify request-body logging. Default `info` records only
meaningful transport lifecycle and security events; per-request route, status,
and duration metadata is emitted at `debug`, so health and administration
polling do not flood normal output.

### R5. Task and SDK visibility

Log task creation/attachment/activation, state transitions, admission or
priority decisions, approval waits/resolutions, interrupt/close/resume,
model/mode/effort control outcomes, SDK query start/result/stop/failure, and
transport cleanup. SDK input/output records may include metadata such as
message kind, UUID presence, and byte/count fields only when those fields are
safe; they must never include prompt, transcript, tool, or model response
content.

### R6. Configurable verbosity

Provide a documented log-level control with a conservative default suitable for
normal foreground operation. The default level is `info`; debug verbosity is
opt-in through an allowlisted environment variable and must preserve all
redaction rules. Invalid log-level configuration fails with a stable
configuration error before listeners bind.

The level policy is:

- `info`: startup/shutdown milestones, pairing stages, WebSocket lifecycle,
  task state, and SDK Query lifecycle.
- `warn` / `error`: expected security or state rejection and unexpected
  runtime/SDK failure, respectively.
- `debug`: HTTP request completion metadata and additional safe diagnostic
  metadata. Request/response bodies remain forbidden at every level.

### R7. Test and documentation coverage

Add unit tests for logger field redaction and level filtering, route/service
tests proving important success and failure events are emitted, and runtime
tests covering startup failure and shutdown milestones. Document how to enable
diagnostic verbosity and how to collect logs when reporting a pairing or SDK
problem.

## Acceptance Criteria

- [x] A normal `agent start` run emits structured startup and listener-ready
      records, and `Ctrl+C` or `agent stop` emits shutdown records.
- [x] Development and production startup each show `Remote health:` and
      `Local administration:` on separate lines; development additionally
      shows `Swagger documentation:` on a separate line and production does
      not.
- [x] A complete pairing attempt can be followed by event name and opaque
      pairing/device IDs through registration, approval, claim, and credential
      issuance; `PAIRING_NOT_APPROVED` identifies the rejected stage without
      printing the six-digit code or credentials.
- [x] Remote HTTP and both WebSocket transports emit authentication, lifecycle,
      rejection, close, and cleanup records with stable event names/codes.
- [x] A task/SDK turn emits enough metadata to distinguish task admission,
      activation, approval, SDK failure, and completion without logging message
      or tool content.
- [x] Automated tests prove forbidden values (master key, access/refresh
      tokens, pairing code/proof, authorization header, prompt, SDK payload) do
      not appear in serialized log output.
- [x] Default and debug log levels are deterministic and documented; invalid
      configuration is rejected before either listener binds.
- [x] Logs are visible in the foreground terminal and PocketPilot creates no
      log file or log-reading endpoint.
- [x] Interactive output has distinct level colors and readable aligned
      metadata; redirected output and `NO_COLOR` contain no ANSI escape codes.
- [x] Existing API/WebSocket payloads, task behavior, pairing semantics, and
      audit storage remain unchanged.

## Out of Scope

- A browser log viewer or mobile log API.
- Persisting conversation content, SDK frames, credentials, or raw HTTP bodies
  to a log file or database.
- Changing pairing approval semantics, task priority semantics, or the raw SDK
  protocol.
