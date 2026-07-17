# Task Runtime Contracts

## Scenario: Persistent Tasks with Separate SDK and Control Transports

### 1. Scope / Trigger

Apply this contract when code creates, controls, restores, terminates, or
persists a task; accepts SDK user messages; publishes SDK/control traffic;
handles approvals; or changes active-turn replay.

The Agent stores task metadata and the SDK session reference only. SDK input,
assistant output, tool input/output, and Claude transcript history never enter
task rows, operation results, audit content, or logs.

### 2. Signatures

```ts
manager.createTask({
  deviceId, operationId, initialCwd, model, permissionMode,
  workspaceRiskAccepted,
});
manager.authorizedWorkspaceRoots(): readonly string[];
manager.submitSdkMessage({ deviceId, taskId, message: SDKUserMessage });
manager.resolveApproval({
  deviceId, operationId, taskId, requestId, result: PermissionResult,
});
manager.interruptTask({ deviceId, operationId, taskId });
manager.closeTask({ deviceId, operationId, taskId });
manager.resumeTask({ deviceId, operationId, taskId });
manager.setModel({ deviceId, operationId, taskId, model });
manager.setPermissionMode({ deviceId, operationId, taskId, permissionMode });
manager.shutdown();

journal.publishSdkMessage(taskId, message: SDKMessage): void;
journal.subscribeSdk(taskId, afterUuid, subscriber): Unsubscribe;
journal.publishControlEvent(taskId, event): TaskControlEventEnvelope;
journal.subscribeControl(taskId, afterCursor, subscriber): Unsubscribe;
```

Remote conversation transport is the bidirectional
`GET /v1/tasks/{taskId}/sdk` WebSocket. `GET /v1/events` is the independent
PocketPilot control WebSocket. `GET /v1/workspaces` returns configured
authorized roots. `/v1/tasks/{taskId}/instruction` does not exist.

### 3. Contracts

- Persist only `idle`, `executing`, `awaiting_approval`, `interrupted`, and
  `terminal`. The common path is `idle -> executing -> awaiting_approval ->
  executing -> idle`.
- A task owns one long-lived SDK input stream and Query while its live session
  exists. Lazily open idle/recovered sessions with persisted `model`,
  `permissionMode`, and `sdkSessionId`; never recreate a transcript.
- A raw SDK frame has no PocketPilot `operationId` and is outside the 24-hour
  HTTP operation-result cache. After accepting it, write one metadata-only
  audit record with device ID, task ID, operation name, and result only.
- An idle message with `shouldQuery !== false` reserves capacity, begins
  active-turn retention, and changes the task to `executing`. An idle
  `shouldQuery: false` message is appended to the same SDK session without
  inventing a turn or consuming active capacity.
- Accept SDK messages while `executing` or `awaiting_approval`. Serialize
  simultaneous socket callbacks only to retain arrival order; never return
  `TASK_BUSY` merely because a turn or approval is active. Preserve `priority`
  and `shouldQuery`; do not implement a PocketPilot scheduler.
- Count query-triggering messages only for lifecycle accounting. A result
  boundary advances retained-turn ownership; the task becomes idle after the
  outstanding SDK query boundaries or authoritative SDK idle state, without
  changing SDK queuing behavior.
- Only `executing` and `awaiting_approval` count toward configured capacity.
  Canonicalize selected cwd and configured roots, require
  `workspaceRiskAccepted: true`, and remember that roots authorize initial cwd
  but are not a filesystem sandbox.
- `GET /v1/workspaces` requires the existing Bearer access credential and
  returns `{ workspaceRoots: string[] }` from the same Zod-validated
  `task-runtime` settings used by task creation. Return a new array, expose no
  other local settings, and do not duplicate settings/SQLite reads in the
  route. These are configured roots; task creation still performs canonical
  existence and descendant authorization checks.
- Normal HTTP controls use the per-task lane and 24-hour
  `(deviceId, operationId)` cache. Interrupt and close bypass the lane. Close
  persists `terminal`, cancels approval, interrupts, and closes the SDK session
  before awaiting cancellation completion.
- An approval uses the SDK `requestId`. The control payload is
  `{ toolName, input, options: Omit<CanUseToolOptions, "signal"> }`; the HTTP
  response body is `{ operationId, result: PermissionResult }`. Return the
  result unchanged to the deferred callback.
- SDK and control journal APIs are disjoint. Raw subscribers receive only
  `SDKMessage`; control subscribers receive only PocketPilot envelopes. Never
  publish `{ kind: "sdk", payload }` on `/v1/events`.
- Retain only the active turn. Use one internal storage order, an in-memory
  SDK `uuid -> storageCursor` map, a memory prefix, and encrypted
  `event_overflow` rows. The internal record wrapper never crosses either
  public protocol.
- SDK reconnect `afterUuid` is outside the message body. A known UUID replays
  later retained SDK records; absent or unknown UUID replays the current turn
  from its beginning. Messages without UUID remain valid and replay normally.
- Control reconnect retains `afterCursor`. At 256 MiB stop later retention but
  continue live delivery and publish
  `EVENT_REPLAY_STORAGE_LIMIT_REACHED` on the control stream. Delete transient
  replay at turn end, terminal cleanup, shutdown, and secure startup.
- At startup mark unfinished active rows `interrupted`. Resume requires a saved
  SDK session ID and uses `Options.resume` without resubmitting any message.
  Manual shutdown cancels live resources and makes all non-terminal rows
  terminal before storage closes.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Workspace risk not accepted | `WORKSPACE_SCOPE_RISK_NOT_ACCEPTED`; create no task. |
| Canonical cwd is outside configured roots | `WORKSPACE_NOT_AUTHORIZED`; create no task. |
| Workspace list request lacks a valid access credential | HTTP 401; expose no configured path. |
| No workspace root is configured | HTTP 200 with `{ workspaceRoots: [] }`. |
| Idle query would exceed active capacity | `CONCURRENT_TASK_LIMIT_REACHED`; submit nothing. |
| Raw input arrives during executing/approval | Accept and forward unchanged; do not return `TASK_BUSY`. |
| Task is interrupted/terminal or SDK input is closed | Raw socket closes `4009 / TASK_SESSION_UNAVAILABLE`. |
| Task does not exist | Raw socket closes `4004 / TASK_NOT_FOUND`. |
| Raw transport fails unexpectedly | Close `4011 / SDK_TRANSPORT_FAILED`; never send an error JSON frame on the SDK socket. |
| Model changes while active | `TASK_BUSY`; do not queue the model change. |
| Approval request ID is stale | `STALE_APPROVAL`; never resolve another SDK callback. |
| Resume lacks an SDK session reference | `TASK_SESSION_UNAVAILABLE`; do not invent a transcript. |
| Replay reaches 256 MiB | Notify control subscribers, retain no later records, and continue live SDK/control delivery. |

### 5. Good / Base / Bad Cases

- Good: a task accepts two SDK user messages during execution, preserves their
  scheduling fields, emits raw Query messages on only its SDK socket, and
  remains active across both SDK result boundaries.
- Base: an SDK socket connects without `afterUuid`; it receives the retained
  current turn from the beginning and then live raw messages.
- Base: an authenticated device lists workspaces before local configuration
  and receives an empty array rather than a synthetic default path.
- Bad: writing raw frames to `operation_results`, wrapping SDK output in a task
  envelope, using one subscriber set for both channels, or rejecting active
  input as busy.

### 6. Tests Required

- Test workspace risk/root policy, idle exclusion and active capacity, raw
  input while idle/executing/awaiting approval, `shouldQuery: false`, queued
  query lifecycle, and same-session object identity.
- Route-test that `/v1/workspaces` rejects unauthenticated requests and returns
  exactly the configured `workspaceRoots` for an authenticated device; OpenAPI
  must include the protected operation and shared response schema.
- Assert SDK input creates metadata-only audit rows and no operation-result
  rows; inspect SQLite/logs for prompt, UUID, tool, and output content.
- Test known/missing/unknown UUID replay, messages without UUID, encrypted
  overflow, cap notification/live delivery, cleanup, task isolation, and
  negative SDK/control cross-delivery.
- Test raw WebSocket authentication, bidirectional deep equality, invalid/base
  frames, stable close codes, multiple tasks, and device revocation.
- Test all serializable approval options and full allow/deny results, plus
  abort, replacement, interrupt, close, and shutdown cancellation.
- Test recovery/resume without replay, close priority, and manual runtime
  shutdown of idle and active tasks.

### 7. Wrong vs Correct

#### Wrong

```ts
if (task.state !== "idle") throw taskBusyError();
return persistOperation({ operationId, result: sdkMessage });
```

This adds an independent scheduler and stores conversation content in the HTTP
idempotency subsystem.

#### Correct

```ts
await taskLane.run(() => session.submit(sdkUserMessage));
recordMetadataOnlyAudit(deviceId, taskId, "task.sdk-message-submitted");
return { workspaceRoots: [...manager.authorizedWorkspaceRoots()] };
```

The lane preserves arrival order only; the SDK controls scheduling and the
Agent records no message content.
