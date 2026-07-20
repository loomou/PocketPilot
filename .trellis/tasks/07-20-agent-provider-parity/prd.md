# Agent Provider Parity

## Goal

Bring Codex App Server to the same PocketPilot product-level workflow
guarantees as the Claude Agent SDK integration, while preserving each
provider's native wire protocol and behavior. A mobile client should be able to
use either provider for the common task lifecycle, live turn state, approvals,
reconnect, and configuration selection without learning provider-internal
PocketPilot state. Provider-specific commands, identifiers, and native frames
remain provider-owned.

## Scope

The user approved implementing **P0 and P1 (R1-R7)** in this task. The work
delivers runtime scheduling and control-event correctness first, followed by
native configuration, reconnect, conversation-boundary, and command-surface
behavior required by the mobile workflow.

This task remains in planning until the user approves `prd.md`, `design.md`,
and `implement.md` and explicitly asks to start implementation.

## Background And Confirmed Facts

- The provider boundary intentionally transports native messages. Claude uses
  raw Claude SDK messages and Codex uses native App Server JSON-RPC-style
  frames; neither is wrapped in a universal `kind`/`payload` envelope. This is
  established by `src/agent-providers/types.ts` and the backend provider
  contracts.
- `taskId`, Codex `threadId`/`sessionId`/`turnId`/`itemId`, Claude
  `sdkSessionId`, JSON-RPC request IDs, and replay cursors are separate
  identities. They must not be collapsed for parity.
- Codex already supports provider-scoped conversation listing, history,
  create/attach/resume, native streaming items, turn start/steer/interrupt,
  approvals, model/effort/collaboration/permission catalogs, workspace path
  authorization, reconnect, and native history replay. The current mobile
  contract is documented in `docs/codex-mobile-integration-guide.en.md` and
  `.zh-CN.md`.
- Claude input goes through `TaskManager`'s capacity lane and per-task lane
  (`src/tasks/task-manager.ts:828-870`, `:2131-2182`). Codex native submission
  currently activates and forwards directly from
  `src/codex-app-server/provider-adapter.ts:312-353`, so it does not inherit
  the same capacity, ordering, generation invalidation, or close/interrupt
  race guarantees.
- Codex turn notifications currently update the task repository directly in
  `src/codex-app-server/provider-adapter.ts:442-484`. Claude publishes task
  state and approval control events through the shared event sink. Codex native
  approvals currently stay on the Agent WebSocket and do not publish the
  common `awaiting_approval` task state.
- Codex's native Agent WebSocket currently exposes an allowlisted method set in
  `src/codex-app-server/protocol.ts:10-60`. It intentionally excludes thread
  creation/resume and destructive account/thread operations from the raw
  socket; those belong to provider conversation REST routes.
- Codex's `CodexNativeJournal` keeps an internal numeric cursor and sends raw
  frames without cursor metadata (`src/codex-app-server/journal.ts:22-82`).
  Replay works, but the mobile client cannot observe or persist the latest
  cursor directly and must currently use native-ID reconciliation.
- The Claude mobile guide defines a fixed slash-command panel and same-task
  `/clear`/`conversation_reset` behavior
  (`docs/mobile-integration-guide.en.md:761-820`). Codex has no equivalent
  PocketPilot command panel or same-task reset contract today; these cannot be
  emulated by inventing Claude commands or wrapping Codex frames.

## Requirements

### P0: Runtime Correctness

- **R1 Shared scheduling:** Codex `turn/start`, `turn/steer`, `turn/interrupt`,
  server-request responses, close, shutdown, and workspace revocation must use
  the shared task priority and lane rules. They must honor configured
  concurrent capacity, preserve per-task ordering, reject stale operations
  after a newer P0/P1 generation, and have deterministic close-vs-interrupt
  behavior.
- **R2 Shared lifecycle projection:** Native Codex `turn/started`,
  `turn/completed`, interruption, and approval transitions must update the
  persisted task state and publish PocketPilot `task.state` events. Each native
  server request also publishes the approved `approval.requested` projection.
  Resolving or clearing approvals returns the task to the correct state through
  `task.state`; no synthetic provider frame is added.
- **R3 Approval ownership:** Every Codex server request must be associated with
  device, task, thread, turn, item, and bridge generation. Common task state,
  cancellation, reconnect, revocation, and shutdown must clear or stale old
  approvals without delivering a response to another task or bridge generation.

### P1: User-Visible Workflow Parity

- **R4 Native configuration controls:** Models, reasoning effort,
  collaboration mode, permission profile, sandbox policy, and approval policy
  must come from Codex-native catalogs/schema and be sent through native turn
  parameters. These operations obey the applicable task-lane and stale-
  operation rules. A Claude-only REST control must reject a Codex task instead
  of reporting a metadata-only success.
- **R5 Deterministic reconnect:** Codex reconnect uses a bounded active-turn
  replay window. The server replays the complete retained active turn when the
  cursor is absent, invalid, or evicted; the mobile client rebuilds its
  in-progress projection from that replay and reconciles final state from
  native history. Native frames receive no PocketPilot cursor field. This flow
  must not produce lost or duplicate visible item deltas.
- **R6 Conversation boundary semantics:** Selecting an existing Codex thread
  loads native history and continues that thread. Creating a new Codex
  conversation uses the App Server's native thread operation; PocketPilot must
  not simulate Claude's same-task `/clear` unless Codex officially exposes an
  equivalent reset. Task, thread, and transcript identities remain separate.
- **R7 Native command/config surface:** The mobile command panel may expose
  only commands or controls that the installed Codex App Server officially
  advertises. Claude-specific `/compact`, `/review`, `/security-review`,
  `/code-review`, `/clear`, and aliases must not be copied into Codex as fake
  commands. Raw native user input remains available where Codex supports it.

## Technical Constraints

- Native Agent WebSocket frames are not normalized across providers.
- For a Codex server request, `/v1/events` publishes
  `kind: "approval.requested"` with
  `{ provider: "codex", requestId, method, params }`. The unchanged native
  request remains on the Codex Agent WebSocket, and the method-specific native
  response returns on that socket.
- Claude's same-task `/clear`/`conversation_reset` and fixed slash-command
  panel are not automatically Codex features.
- Provider-specific catalogs, approval results, history rows, and conversation
  identifiers remain native and extensible.
- `/v1/events` stays independent from provider-native frames. Common task and
  approval projections must never be inserted into the Agent WebSocket payload.
- Prompt text remains opaque. Only known path-bearing Codex fields are subject
  to PocketPilot workspace authorization.

## Acceptance Criteria

- [ ] A Codex turn submitted while capacity is exhausted follows the same
  configured rejection behavior as Claude; a close, interrupt, or root
  revocation cannot be overtaken by an older queued Codex operation.
- [ ] Codex `turn/started`, `turn/completed`, interruption, and approval
  transitions produce correct persisted task states and `/v1/events` control
  records, while Agent WebSocket frames remain native apart from PocketPilot's
  private request-ID remapping.
- [ ] Concurrent approvals from multiple tasks are isolated; stale approval
  responses after bridge restart, interrupt, close, revocation, or shutdown
  return the documented error and do not reach a new App Server generation.
- [ ] Codex model/effort/mode/permission selections reach the native App Server
  through its schema, or return a clear unsupported error. No metadata-only
  success is reported for a native setting that was not applied.
- [ ] Reconnect rebuilds the retained active turn and reconciles native history
  without lost or duplicate visible items, including absent, invalid, and
  evicted cursor cases.
- [ ] Existing-thread attach/history and new-thread creation preserve native
  Codex identities and do not reuse Claude `/clear` semantics.
- [ ] Codex controls contain only installed/native capabilities; unsupported
  Claude slash commands are absent.
- [ ] Existing Claude behavior and all current provider-native tests remain
  green. Offline tests cover R1-R7, and the caller-configured live suite covers
  stable catalog, turn, stream, interrupt, history, and resume paths supported
  by the installed Codex version.

## Out Of Scope

- **R8 Thread management:** mobile-facing native rename, archive/delete, fork,
  compact, or equivalent thread operations.
- **R9 Attachments:** a PocketPilot mobile upload/reference API for files and
  images. Existing authorized computer-side paths remain usable.
- **R10 Extended live coverage:** real approval fixtures, attachments, and
  destructive thread operations that require caller-specific setup.
- Broadening the raw Agent WebSocket allowlist with account, configuration,
  filesystem, process, plugin, arbitrary MCP, or other privileged methods.
