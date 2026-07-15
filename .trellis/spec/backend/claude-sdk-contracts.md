# Claude Agent SDK Contracts

## Scenario: Long-Lived Claude Agent SDK Session

### 1. Scope / Trigger

This contract applies when code creates, resumes, controls, or relays events
from an `@anthropic-ai/claude-agent-sdk` `Query`.

The SDK's `Query.streamInput()` closes Claude CLI stdin after its supplied
`AsyncIterable` completes. Treating it as a per-turn method terminates a task's
interactive session and loses the ability to submit later instructions.

### 2. Signatures

```ts
openClaudeSdkSession(options: {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  canUseTool?: CanUseTool;
}): ClaudeSdkSession;

session.submit(message: SDKUserMessage): void;
session.events(): AsyncGenerator<NormalizedClaudeSdkEvent>;
```

`ClaudeSdkInputStream` is the one task-scoped
`AsyncIterable<SDKUserMessage>` passed to `query({ prompt })`. It is consumed
once by the SDK and stays open until task close or coordinated shutdown.

### 3. Contracts

- Push every instruction for a task into its existing `ClaudeSdkInputStream`.
  Do not call `Query.streamInput()` again after the initial query setup.
- `SDKMessage.session_id`, observed by the task event loop, is the persistent
  SDK-session reference. Neither `Query` nor `initializationResult()` exposes
  it directly.
- SDK hook events can precede `system:init`; do not assume the first event is
  initialization. A session ID is unavailable until the first user instruction
  has been streamed and its init event has been observed.
- Store only the session ID and task metadata. SDK messages are transient event
  relay input, not an Agent-managed canonical transcript.
- `Options.resume` receives the previously captured session ID to reconnect an
  interrupted task. It never retries the interrupted instruction.
- Forward a task's initially selected model and permission mode in `Options`
  when its SDK session is first opened. A task whose live session already
  exists uses `setModel()` or `setPermissionMode()` instead.
- Forward `setPermissionMode()` and `setModel()` through the wrapper. The task
  state machine, not the adapter, applies the product's idle-only model rule.
- `canUseTool` receives an SDK `AbortSignal`, `requestId`, and `toolUseID`.
  Pending approval cancellation must reject its deferred decision; task close,
  interrupt, and shutdown must invoke that cancellation.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Input stream is closed | Reject a later `submit`; never reopen or create an implicit new Query. |
| A second consumer iterates the stream | Throw; an SDK Query owns the single consumer. |
| SDK aborts a pending tool approval | Reject with `ToolApprovalCancelledError`; do not silently allow or return `null`. |
| First SDK event is a hook event | Relay it as `sdk.system`, then wait for `session.initialized`. |
| Requested model change while task is executing | Future task runtime returns `TASK_BUSY`; it must not enqueue a later model switch. |
| SDK permission mode unsupported by the pinned version | Future API returns `UNSUPPORTED_PERMISSION_MODE`; never fall back to another mode. |

### 5. Good / Base / Bad Cases

- Good: one open input stream accepts a first instruction, reaches an idle
  result, then accepts a second instruction on the same SDK session.
- Base: a task has not yet received an instruction, so it has no `session_id`
  to persist and is not treated as resumable.
- Bad: ending a finite stream after every instruction and calling
  `query.streamInput(nextTurn)` later. The first completion closes CLI stdin,
  so the later write cannot be a reliable continuation.

### 6. Tests Required

- Unit-test that `ClaudeSdkInputStream` yields queued later messages without
  ending, closes deterministically, and rejects pushes after close.
- Unit-test `Options.resume` forwarding, permission approval resolution, and
  `AbortSignal` cancellation.
- Unit-test normalized event mapping: assistant output, stream deltas, result,
  init, state change, denied permission, other system events, and omitted user
  echoes.
- Keep an opt-in live test (`CLAUDE_SDK_LIVE=1`) for the pinned package that
  discovers initialization/models, submits two turns through one stream,
  changes permission/model between turns, and sends an interrupt receipt.

### 7. Wrong vs Correct

#### Wrong

```ts
await query.streamInput(singleTurnInput("first turn"));
await query.streamInput(singleTurnInput("later turn"));
```

The first finite stream ends stdin before the second call.

#### Correct

```ts
const session = openClaudeSdkSession({ cwd });

session.submit(createSdkUserMessage("first turn"));
// After the SDK reports this turn idle:
session.submit(createSdkUserMessage("later turn"));
```

The task runtime owns the state transition; the adapter preserves one SDK input
stream and one conversation session.
