# Agent Provider Parity Implementation Plan

## Preconditions And Review Gates

- Keep the task in `planning` until this document and `design.md` are reviewed
  and the user explicitly asks to start implementation.
- Before code changes, run the inline Trellis pre-development context for the
  backend package and re-read the task/runtime, provider, Codex, API
  documentation, logging, and error-handling specs.
- Do not modify or discard the unrelated uncommitted Codex documentation
  changes already present on `main`.

## Ordered Checklist

### 1. Define the shared provider task-runtime port

- Add the narrow type/interface for provider task operations, leases, capacity
  reservation, lifecycle state projection, approval projection, and journal
  turn boundaries.
- Implement it in `TaskManager` by reusing `TaskOperationScheduler`, the
  existing capacity lane, `publishTaskState`, `TaskEventSink`, and current P0/P1
  invalidation paths.
- Ensure Claude's public behavior and tests remain unchanged; use a fake port
  in new adapter unit tests.

Rollback point: only new types and a no-op/fake integration seam exist; no
Codex forwarding behavior changes yet.

### 2. Move Codex submission onto the shared runtime

- Inject the provider port into `CodexProviderAdapter` from
  `src/runtime/agent-runtime.ts`.
- Route `turn/start`, `turn/steer`, native approval responses, and native
  `turn/interrupt` through the correct P0/P1/P2 operation path.
- Reserve capacity before an idle `turn/start`, roll back on bridge failure,
  and preserve the original client JSON-RPC ID and native frame shape.
- Add lease checks before and after each bridge call. Remove direct Codex
  repository writes for state transitions that belong to `TaskManager`.

Rollback point: the adapter can still be disabled at runtime construction while
existing conversation list/history routes remain available.

### 3. Project Codex lifecycle and approvals to `/v1/events`

- Update notification handling to call the shared lifecycle port for
  `turn/started`, `turn/completed`, interrupt completion, and terminal guards.
- Track pending server requests with generation and native ownership metadata.
- Publish provider-tagged `approval.requested` events while retaining the
  original native request on the Agent WebSocket.
- Resolve multiple approvals independently; keep `awaiting_approval` until the
  pending set is empty; clear all requests on interrupt, close, revocation,
  bridge failure, generation change, and shutdown.
- Add structured metadata-only logs and audit assertions.

### 4. Implement deterministic active-turn replay

- Add `beginTurn`, `endTurn`, task isolation, and bounded retention behavior to
  `CodexNativeJournal`.
- Define unknown/invalid/evicted cursor behavior as full active-turn replay.
- Update the Agent WebSocket documentation and OpenAPI notes to state that
  native frames remain unchanged and Codex clients rebuild the current-turn
  projection on reconnect.

### 5. Correct native configuration and command behavior

- Ensure Codex catalog reads are read-only and sourced from the installed App
  Server. Add collaboration and permission catalog fixtures/tests.
- Make common Claude-only REST controls reject Codex explicitly instead of
  persisting metadata without forwarding a native setting.
- Verify docs and mobile guides show native `turn/start` parameter selection,
  no fabricated Claude slash-command panel, and native new-thread semantics.
- Update generated OpenAPI descriptions and route tests if the public error
  contract changes.

### 6. Focused tests

- Extend `test/codex-app-server/provider-adapter.test.ts` for shared-lane
  ordering, capacity rejection/reservation rollback, P1 invalidation, state
  projection, concurrent approvals, stale generations, and terminal cleanup.
- Extend `test/codex-app-server/journal.test.ts` for active-turn reset,
  fallback replay, bounds, and task isolation.
- Extend `test/remote-api/task-agent-routes.test.ts` and
  `test/remote-api/task-event-routes.test.ts` for native frame equality,
  provider-tagged approval events, reconnect behavior, and stable close/error
  mappings.
- Add TaskManager tests proving Claude scheduling and controls are unchanged.
- Add tests for Codex-only REST control rejection and native catalog passthrough.

### 7. Caller-configured live verification

- Extend `test/codex-app-server/live-contract.test.ts` only for stable P0/P1
  paths that do not require a user-specific approval or attachment fixture:
  initialize, model/collaboration/permission catalogs, native streaming,
  steer where supported, interrupt, history, and resume.
- Run with a caller-provided workspace; never commit the workspace, command,
  account, or credential:

```powershell
$env:CODEX_APP_SERVER_TEST_CWD = "<absolute-workspace-path>"
pnpm test:codex:live
```

Real approvals, attachments, and destructive thread operations remain P2.

### 8. Documentation and integration contract

- Update the English and Chinese Codex mobile guides, native App Server guide,
  README links, and generated OpenAPI notes to match the final behavior.
- Document the `/v1/events` Codex approval projection, task state transitions,
  native response path, replay reset rule, and unsupported Claude-only controls.
- Run Markdown link/code-fence checks used by the repository.

### 9. Quality gate and finish review

- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the configured live test
  when Codex is installed and authenticated.
- Run `git diff --check` and inspect the full diff for native-frame wrappers,
  prompt/output logging, unauthorized path parsing, direct repository writes,
  and accidental changes to Claude behavior.
- Apply the Trellis quality check and update the relevant backend spec if a new
  reusable runtime contract is learned.
- Only after the quality gate passes should the task be started, committed, and
  prepared for integration.

## Risky Files And Rollback Points

| Area | Files | Risk | Rollback |
| --- | --- | --- | --- |
| Shared lifecycle | `src/tasks/task-manager.ts`, `src/tasks/task-operation-scheduler.ts` | Claude state/priority regression | Revert provider-port wiring; keep existing Claude path |
| Codex adapter | `src/codex-app-server/provider-adapter.ts`, `src/runtime/agent-runtime.ts` | Native request ordering or stale approvals | Disable adapter gateway and preserve native bridge/conversation APIs |
| Event projection | `src/tasks/task-event-journal.ts`, task event routes | Cross-channel duplication or leaked payloads | Remove Codex control projection; native stream remains raw |
| Replay | `src/codex-app-server/journal.ts`, Agent WebSocket docs/routes | Lost or duplicated deltas | Restore retained-window fallback and require history reconciliation |
| Public contract | `src/remote-api/*`, `src/api-docs/*`, `docs/*` | Mobile client mismatch | Roll back generated docs with code; no database impact |

## Validation Matrix

| Requirement | Offline evidence | Live evidence |
| --- | --- | --- |
| R1 scheduling | TaskManager/adapter lane, capacity, invalidation tests | Native start/interrupt smoke |
| R2 lifecycle | Event journal and state projection tests | Started/completed notification stream |
| R3 approvals | Multi-task/generation/stale approval tests | Optional caller-controlled approval fixture deferred |
| R4 native controls | Catalog passthrough and unsupported REST control tests | Catalog requests against installed server |
| R5 reconnect | Journal reset/fallback and route replay tests | Native history reconciliation smoke where stable |
| R6 conversation boundary | Create/attach/history identity tests | Thread start/read/resume smoke |
| R7 command surface | Capability/docs/OpenAPI contract tests | Native input smoke only; no invented commands |
