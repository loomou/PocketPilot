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

new CodexProviderAdapter({ bridge, repository, workspaceDirectoryResolver });
adapter.listConversations(input): Promise<AgentConversationPage<unknown>>;
adapter.readConversation(input): Promise<AgentConversationPage<unknown>>;
adapter.createConversation(input): Promise<TaskOperationResult>;
adapter.attachConversation(input): Promise<TaskOperationResult>;
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
- A bridge generation change resumes every activated thread before forwarding
  new work. Clear approval IDs from the previous generation before resume; a
  client response to one of those IDs returns `STALE_APPROVAL`.
- `turn/start` is asynchronous on the native stream. Use the `turn/started`
  notification as the authoritative source of the active `turnId`; do not wait
  for the request response before offering interrupt. `turn/completed` remains
  the authoritative terminal event.
- `afterCursor` is PocketPilot transport metadata. Codex frames never contain
  it. An unknown or evicted cursor replays the retained native window.

### Remote methods, history, and approvals

- The task stream may forward only `turn/start`, `turn/steer`,
  `turn/interrupt`, `thread/read`, `thread/turns/list`, `thread/items/list`,
  `model/list`, `collaborationMode/list`, and `permissionProfile/list`.
- Conversation REST methods own `thread/list`, `thread/read`, `thread/start`,
  `thread/resume`, and detach. Account/configuration writes, filesystem/process
  RPCs, plugin installation, arbitrary MCP calls, archive/delete, and unknown
  privileged methods are denied from the remote stream.
- List CLI, VS Code, and App Server thread sources. Prefer negotiated
  `thread/turns/list` pagination and preserve native rows; use only an explicitly
  bounded `thread/read(includeTurns=true)` fallback.
- Track each server request by native JSON-RPC request ID and owning task,
  thread, turn, item, and method. Multiple requests may be pending concurrently.
  Return method-specific native results unchanged. Clear requests on native
  resolution, turn completion, interrupt, close, revocation, bridge exit, or
  shutdown.
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
| `turn/steer` or `turn/interrupt` names a stale turn | `409 TASK_BUSY`; do not substitute a different active turn. |
| A cursor is absent, invalid, or outside retention | Replay the retained native window without modifying its frames. |

## 5. Good / Base / Bad Cases

- Good: the mobile client sends a native `turn/start`; PocketPilot remaps only
  its JSON-RPC request ID, publishes native `turn/started`, and later forwards
  native item deltas and `turn/completed` unchanged.
- Good: App Server exits with two pending approvals; reconnect resumes the same
  thread and both old request IDs become stale before any new frame is sent.
- Base: `thread/list` returns mixed roots and sources; PocketPilot includes
  `cli`, `vscode`, and `appServer`, then removes rows outside the authorized
  workspace without changing retained rows.
- Bad: wrapping frames in `{ kind: "codex", payload }`, using `taskId` as a
  thread or turn ID, parsing absolute paths from prompt text, or allowing an old
  child's close event to kill its replacement.

## 6. Tests Required

- Bridge tests cover handshake, correlation, duplicate client IDs across tasks,
  timeouts, malformed/oversized frames, process exit, late old-process events,
  Windows command resolution, bounded writes, and deterministic shutdown.
- Adapter tests cover list/read/start/resume, native row identity, concurrent
  approvals, server-request path rejection, stale approvals after generation
  changes, start/steer/interrupt state, workspace revocation, and cleanup.
- Journal tests cover task isolation, entry/byte eviction, known cursor replay,
  and absent/unknown/stale cursor fallback.
- The caller-configured live suite must prove initialize, `model/list`, all
  thread sources, `thread/start`, native streaming, `thread/turns/list`,
  `thread/read`, `thread/resume`, active-turn interrupt, archive cleanup, and
  process shutdown:

```powershell
$env:CODEX_APP_SERVER_TEST_CWD = "<absolute-workspace-path>"
pnpm test:codex:live
```

The suite must not commit a workspace path, executable path, account, or
credential. Ordinary `pnpm test` skips it.

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
