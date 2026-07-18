# Implementation Plan

## Ordered Checklist

1. Add the logger package declaration and bootstrap configuration:
   `POCKETPILOT_LOG_LEVEL`, validation, `.env.example`, README instructions,
   and environment tests. Confirm invalid configuration fails before SQLite or
   listener setup.
2. Implement the shared Pino-backed logger and colored terminal formatter with
   capture-friendly output, level filtering, UUID shortening, safe scalar
   fields, redaction, TTY detection, and `NO_COLOR` handling. Add focused unit
   tests for formatting, filtering, truncation, and forbidden-value absence.
3. Thread an optional logger through `AgentRuntime`, `createHttpApp`, remote
   app, local-admin app, auth error handling, and route option types. Add
   startup/storage/listener/control-state/shutdown events and separate startup
   endpoint lines while retaining `Fastify({ logger: false })`. Verify that
   source-development output adds Swagger and built production output omits it.
4. Instrument pairing and authentication success/failure boundaries in
   `DeviceAuthService`, remote/local auth routes, and the device connection
   registry. Add tests that trace registration -> approval -> claim and the
   `PAIRING_NOT_APPROVED` rejection without exposing the verification code or
   credentials.
5. Instrument control and SDK WebSocket routes for handshake, subscription,
   activation, invalid frames, close codes, and cleanup. Add route tests for
   authenticated, rejected, and disconnected sockets and assert no frame
   payload is logged.
6. Instrument `TaskManager` and the SDK event loop for task creation/attachment,
   state transitions, admission, controls, approvals, query lifecycle, safe
   message metadata, and shutdown. Add tests for an executing turn, approval,
   SDK failure, and terminal cleanup.
7. Run formatting/typecheck/unit tests, inspect captured terminal output for
   the approved colored layout, and run the opt-in live SDK test only if the
   developer supplies `CLAUDE_SDK_TEST_CWD`.
8. Run the complete Trellis quality check, update backend logging guidance with
   the final event/configuration contract, then prepare the task for review.

## Validation Commands

```powershell
pnpm lint
pnpm typecheck
pnpm test
$env:POCKETPILOT_LOG_LEVEL = "debug"
pnpm dev
Remove-Item Env:POCKETPILOT_LOG_LEVEL
```

For color behavior, capture logger output through a non-TTY writable stream and
assert no ANSI sequences; run the foreground command in an interactive
terminal to inspect the colored layout. Do not commit `.env` or a developer
workspace path.

## Risky Files and Rollback Points

- `src/logging/*`, `src/config/environment.ts`, and package metadata: bootstrap
  or dependency risk; validate before touching runtime startup.
- `src/runtime/agent-runtime.ts` and `src/http/create-http-app.ts`: listener
  or shutdown regressions; preserve existing route isolation tests.
- `src/auth/*` and WebSocket route files: accidental credential/frame leakage;
  keep logger fields typed and add forbidden-value assertions.
- `src/tasks/task-manager.ts`: lifecycle timing risk; instrumentation must be
  side-effect-free and never await logging.
- `.trellis/spec/backend/logging-guidelines.md`: update only after tests pass.

Rollback can remove logger calls and dependency/configuration wiring without a
database migration or API contract change.
