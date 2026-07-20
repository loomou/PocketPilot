# Codex App Server Contracts

## 1. Scope / Trigger

Apply this contract when changing the Codex provider, its official local App
Server bridge, the Codex-native Agent WebSocket, or Codex task metadata. Codex
is a provider adapter, not a second Claude message model.

## 2. Signatures

```ts
new CodexAppServerBridge(options);
bridge.start(): Promise<CodexInitializeInfo>;
bridge.request(method, params): Promise<unknown>;
bridge.forward(taskId, nativeFrame): Promise<void>;
bridge.respond(requestId, nativeResult): Promise<void>;
bridge.rejectServerRequest(requestId, message): Promise<void>;
bridge.close(): Promise<void>;

adapter.listConversations(input): Promise<AgentConversationPage<unknown>>;
adapter.readConversation(input): Promise<AgentConversationPage<unknown>>;
adapter.createConversation(input): Promise<TaskOperationResult>;
adapter.attachConversation(input): Promise<TaskOperationResult>;

new CodexProviderAdapter({
  bridge,
  journal,
  providerTaskRuntime: taskManager.providerTaskRuntime(),
  repository,
  workspaceDirectoryResolver,
});
```

The task table persists `active_turn_id`, `native_conversation_id`, and
`native_session_id`. The remote task stream is:

```text
GET /v1/tasks/{taskId}/agent?afterCursor={pocketpilotCursor}
```

## 3. Contracts

### Native bridge

- Start one `codex app-server --listen stdio://` process per Agent runtime and
  complete `initialize` followed by `initialized` before any other method.
- Parse newline-delimited JSON objects and correlate JSON-RPC responses by an
  internal connection ID. A shared bridge remaps duplicate client IDs privately
  and restores the client's original ID only on the owning task stream.
- Resolve Windows `.exe`, `.cmd`, `.bat`, and `.ps1` commands explicitly. A
  `.cmd` shim uses `cmd.exe` with verbatim arguments; a `.ps1` shim uses a
  non-interactive PowerShell host. Prompt data never enters a shell command.
- Process listeners belong to the child generation that registered them. Ignore
  stdout, error, or close events from an old child after a replacement starts.
  Reset the partial stdout buffer and initialize metadata on connection failure.
- On timeout, malformed output, unsupported protocol version, process error, or
  process exit, reject pending client requests and terminate the Windows process
  tree.

### Identity, state, and reconnect

- Persist `provider`, `nativeProtocolVersion`, `nativeConversationId` (Codex
  `threadId`), `nativeSessionId`, and `activeTurnId` separately from `taskId`.
  The partial unique index applies to `(provider, nativeConversationId)` for
  non-terminal tasks. A restart never creates a replacement thread.
- `turn/started` stores `activeTurnId` and moves the task to `executing`.
  `turn/completed` clears `activeTurnId` and pending server requests, and moves
  a non-terminal task to `idle`; late notifications cannot resurrect a terminal
  task.
- `turn/start`, `review/start`, `thread/compact/start`, `thread/name/set`,
  `turn/steer`, and native approval responses run through the shared P2 task
  lane. Turn-starting methods (`turn/start`, `review/start`,
  `thread/compact/start`) require `idle`, reserve shared cross-provider
  capacity, begin active-turn journal retention, and record ownership before
  the frame is forwarded. They share one pending-turn-start path and roll back
  the reservation plus replay window if forwarding fails or a native error
  arrives before an authoritative turn becomes active.
- Runtime-only `activeTurnKind` tracks `normal`, `review`, or `compact`. It is
  never persisted. While a pending start of the current bridge generation
  exists, treat that pending kind as active for steering policy. On
  `turn/started`, promote the pending kind to the active kind; on
  `turn/completed`, interrupt completion, close, or generation reset, clear it.
- While `activeTurnKind` is `review` or `compact`, reject `turn/steer` with
  `409 TASK_BUSY`. Interrupt remains allowed against the current active turn
  ID for every turn kind.
- `thread/name/set` is P2 work that does not start a turn: it does not require
  idle, does not reserve capacity, and does not begin journal retention. Bind
  it to the current task thread only.
- Native `turn/interrupt` is P1. Persist `interrupted`, invalidate older queued
  and active P2 leases, clear pending approvals/turn starts, clear
  `activeTurnKind`, end replay, and forward only when the named turn is still
  current. Complete cleanup to `idle` when the native response arrives, even if
  no `turn/completed` follows.
- A bridge generation change resumes every activated thread before forwarding
  new work. Clear approval IDs and generation-scoped pending turn starts from
  the previous generation before resume; a client response to one of those IDs
  returns `STALE_APPROVAL`.
- Turn starts are asynchronous on the native stream. Use the `turn/started`
  notification as the authoritative source of the active `turnId`; do not wait
  for the request response before offering interrupt. `turn/completed` remains
  the authoritative terminal event. After `turn/started` has set
  `activeTurnId`, a late native error for the original request must not roll
  back capacity, journal retention, or ownership.
- `afterCursor` is PocketPilot transport metadata. Codex frames never contain
  it. Retain only the active turn: `beginTurn()` clears the prior window and
  `endTurn()` clears retained frames without disconnecting subscribers. A
  missing, invalid, unknown, or evicted cursor replays the full retained active
  turn; a known cursor replays only later native frames.

### Remote methods, history, and approvals

- The task stream may forward only `turn/start`, `turn/steer`,
  `turn/interrupt`, `review/start`, `thread/name/set`,
  `thread/compact/start`, `thread/read`, `thread/turns/list`,
  `thread/items/list`, `model/list`, `collaborationMode/list`,
  `permissionProfile/list`, `account/read`, `account/rateLimits/read`,
  `skills/list`, `hooks/list`, and `mcpServerStatus/list`.
- Validate action params before forward:
  - `review/start`: only `delivery` omitted/`null`/`"inline"`; reject
    `"detached"` and unknown deliveries. Require a supported native
    `target` of type `uncommittedChanges`, `baseBranch`, `commit`, or
    `custom` with bounded text fields.
  - `thread/name/set`: require a non-empty bounded `name`.
  - `thread/compact/start`: bind only to the current task thread; no extra
    remote fields are required.
- `model/list`, `collaborationMode/list`, `permissionProfile/list`,
  `thread/read`, `thread/turns/list`, `thread/items/list`, `account/read`,
  `account/rateLimits/read`, `skills/list`, `hooks/list`, and
  `mcpServerStatus/list` are P3 reads. They do not wait behind P2 input, and
  they recheck task availability plus current workspace authorization around
  activation/path validation and after forward.
- Status-catalog reads stay native and path-safe:
  - Reject `account/read` with `refreshToken: true`.
  - Skills/hooks official params use `cwds[]`. Accept legacy single `cwd` by
    rewriting it to `cwds`. When no path root is provided, inject the current
    authorized task workspace. Authorize every requested root under that
    workspace before forward.
  - Project responses and matching notifications to closed path-safe payloads
    before journal publish. Drop absolute paths (`cwd`/`path`/`sourcePath`/
    absolute icons), email, refresh tokens, hook `command`, raw env/command
    material, and other host-local secrets. Preserve stable UI fields such as
    names, enabled flags, status enums, planType/authMode, quota numbers, and
    tool names.
  - Project `account/read` through a closed readiness shape
    (`requiresOpenaiAuth` plus nested account `type`/`planType`/`authMode`
    only). Never passthrough native email or credential fields.
  - Forward only reviewed status notifications:
    `account/updated`, `account/rateLimits/updated`, `skills/changed`,
    `hook/started`, `hook/completed`, and the native
    `mcpServer/startupStatus/updated` event. Apply the same projection rules.
  - Process-level notifications without a task-bound `threadId`
    (`skills/changed`, `account/updated`, `account/rateLimits/updated`, and
    process-level MCP startup updates) fan out to non-terminal Codex task
    journals after projection. Thread-bound hook notifications remain
    thread-scoped only.
- Conversation REST methods own `thread/list`, `thread/read`, `thread/start`,
  `thread/resume`/attach, fork, archive, unarchive, and delete. Agent WebSocket
  clients do not send those lifecycle mutations. Do not invent REST mutation
  routes for review, rename, compact, or status catalogs. Account/configuration
  writes, filesystem/process RPCs, plugin installation, arbitrary MCP calls,
  detached review, deprecated `thread/rollback`, path-based fork, and unknown
  privileged methods are denied from the remote stream.
- Provider readiness for Codex is a bounded App Server initialize probe:
  command missing → `not_installed` / `CODEX_COMMAND_NOT_FOUND`; unsupported
  CLI/protocol → `unsupported_version` /
  `CODEX_APP_SERVER_VERSION_UNSUPPORTED`; timeout/unexpected failure →
  `unhealthy` / `CODEX_APP_SERVER_PROBE_FAILED`; success → `available`.
  Short-lived probe children must close in `finally` and must not leave orphan
  App Server processes.
- List supports optional `includeArchived` / `searchTerm` filters by forwarding
  native `thread/list` params `archived` and `searchTerm` after workspace
  authorization.
- Codex capabilities publish
  `historyFilters: { includeSystemMessages: false }`. History
  `readConversation` rejects `includeSystemMessages === true` with
  `409 HISTORY_FILTER_NOT_SUPPORTED` before any native `thread/turns/list`
  or fallback history request. Omit or `false` returns native turn/item rows
  unchanged; do not invent Claude-like system-message filtering.
- Fork uses native `thread/fork` with `{ threadId }` only. After fork, authorize
  the new thread and create/reuse a PocketPilot task for it.
- Archive/unarchive/delete use native `thread/archive`, `thread/unarchive`, and
  `thread/delete`. Archive and delete require `confirm: true`. Archive does not
  auto-close bound tasks. Delete closes a currently bound non-terminal task only
  after native delete succeeds.
- List CLI, VS Code, and App Server thread sources. Prefer negotiated
  `thread/turns/list` pagination and preserve native rows; use only an explicitly
  bounded `thread/read(includeTurns=true)` fallback.
- Track each server request by native JSON-RPC request ID, owning device, bridge
  generation, task, thread, turn, item, and method. Multiple requests may be
  pending concurrently. Return method-specific native results unchanged only
  from the owning device and generation. Clear requests on native resolution,
  turn completion, interrupt, close, revocation, bridge exit, or shutdown.
- Publish a secondary PocketPilot control projection as
  `{ kind: "approval.requested", payload: { provider: "codex", requestId,
  method, params } }`. This projection is for task UI/state only; the native
  request and its response remain unchanged on the Codex Agent WebSocket.
- Path authorization checks only path-bearing Codex fields such as `cwd`,
  roots, sandbox roots, and attachment paths. Prompt text is opaque user input.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Codex command is absent | Provider remains discoverable as `not_installed`; starting it is not attempted. |
| Installed CLI is outside the reviewed `0.144.x` protocol | Provider fails closed as unsupported; no task stream starts. |
| Native output is malformed or oversized | Reject every pending request, terminate the owning process, and discard its partial stdout. |
| An old child emits data/error/close after reconnect | Ignore the event; do not terminate or corrupt the replacement connection. |
| Two tasks use the same client JSON-RPC ID | Allocate distinct wire IDs and return each response only to its owning task. |
| A server request contains an unauthorized path | Send native JSON-RPC error `-32601`; never publish the request remotely. |
| A response references a cleared or prior-generation approval | `409 STALE_APPROVAL`; write nothing to the new App Server process. |
| A different device answers a pending approval | `409 STALE_APPROVAL`; preserve the request for its owning device. |
| `turn/start`, `review/start`, or `thread/compact/start` arrives while the task is active | `409 TASK_BUSY`; only normal turns accept later input through `turn/steer`. |
| `turn/steer` targets a review or compact turn | `409 TASK_BUSY`; review/compact are non-steerable. |
| `turn/steer` or `turn/interrupt` names a stale turn | `409 TASK_BUSY`; do not substitute a different active turn. |
| `review/start` uses detached or unsupported delivery/target | `403 CODEX_REQUEST_NOT_ALLOWED`; do not forward. |
| `thread/name/set` name is empty, missing, or over the bounded length | `403 CODEX_REQUEST_NOT_ALLOWED`; do not forward. |
| A cursor is absent, invalid, or outside retention | Replay the retained native window without modifying its frames. |
| A Claude-only composer/model/mode/effort route targets Codex | `409 TASK_CONTROL_NOT_SUPPORTED`; use Codex native catalogs and turn parameters. |

## 5. Good / Base / Bad Cases

- Good: the mobile client sends a native `turn/start`; PocketPilot remaps only
  its JSON-RPC request ID, publishes native `turn/started`, and later forwards
  native item deltas and `turn/completed` unchanged.
- Good: an inline `review/start` or `thread/compact/start` shares the normal
  turn-start lifecycle (idle, capacity, journal, ownership, rollback) and later
  rejects `turn/steer` while still accepting interrupt.
- Good: `thread/name/set` renames the current task thread through P2 without
  capacity reservation or idle gating.
- Good: App Server exits with two pending approvals; reconnect resumes the same
  thread and both old request IDs become stale before any new frame is sent.
- Good: two devices can observe task control events, but only the device that
  started the turn can answer its native Codex approval request.
- Base: an active P2 turn is blocked waiting on native work while `model/list`
  or a status-catalog P3 read proceeds independently after workspace
  reauthorization.
- Base: `account/read`, `skills/list`, `hooks/list`, `mcpServerStatus/list`,
  and `account/rateLimits/read` project path-safe native payloads; matching
  notifications are forwarded with the same projection and never invent REST
  mutation routes.
- Base: `thread/list` returns mixed roots and sources; PocketPilot includes
  `cli`, `vscode`, and `appServer`, then removes rows outside the authorized
  workspace without changing retained rows.
- Bad: wrapping frames in `{ kind: "codex", payload }`, inventing PocketPilot
  action envelopes, using `taskId` as a thread or turn ID, advertising
  detached review or attachments, parsing absolute paths from prompt text, or
  allowing an old child's close event to kill its replacement.
- Bad: forwarding `account/read` with `refreshToken: true`, leaking skill/hook
  absolute paths, or inventing REST routes for status catalogs.

## 6. Tests Required

- Bridge tests cover handshake, correlation, duplicate client IDs across tasks,
  timeouts, malformed/oversized frames, process exit, late old-process events,
  Windows command resolution, bounded writes, and deterministic shutdown.
- Adapter tests cover list/read/start/resume, native row identity, concurrent
  approvals, server-request path rejection, stale approvals after generation
  changes and device mismatch, start/steer/interrupt state, review/compact
  non-steerable turns, rename without capacity, shared capacity/P2
  invalidation, pending-start rollback only before authoritative
  `turn/started`, P3 reads including status catalogs, response/notification
  projection for account/skills/hooks/mcpServers/rateLimits, workspace
  revocation, and cleanup.
- Journal tests cover task isolation, entry/byte eviction, known cursor replay,
  absent/unknown/stale cursor fallback, active-turn reset, and end-turn cleanup
  without dropping live subscribers.
- The caller-configured live suite must prove initialize, readiness probe
  semantics, `model/list`, all thread sources, `thread/start`, native streaming,
  `thread/turns/list`, `thread/read`, `thread/resume`, active-turn interrupt,
  non-destructive status-catalog reads when available, disposable
  fork/archive/unarchive cleanup, and process shutdown:

```powershell
$env:CODEX_APP_SERVER_TEST_CWD = "<absolute-workspace-path>"
pnpm test:codex:live
```

The suite must not commit a workspace path, executable path, account, or
credential. Ordinary `pnpm test` skips it. Live cleanup must prefer disposable
forked threads and must not leave permanent host threads behind.

## 7. Wrong vs Correct

### Wrong

```ts
const started = await bridge.request("turn/start", params);
await bridge.request("turn/interrupt", {
  threadId: taskId,
  turnId: started.turn.id,
});
```

This waits on the wrong signal and mixes PocketPilot and Codex identities. The
turn can finish before the response is observed.

### Correct

```ts
await bridge.forward(taskId, nativeTurnStartFrame);
// turn/started updates the persisted activeTurnId for this thread.
await bridge.request("turn/interrupt", { threadId, turnId: activeTurnId });
```

The native notification supplies the authoritative active turn while task,
thread, turn, request, and replay identities remain separate.
