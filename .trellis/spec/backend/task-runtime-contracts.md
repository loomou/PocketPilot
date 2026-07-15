# Task Runtime Contracts

## Scenario: Persistent, Independently Controlled Claude Tasks

### 1. Scope / Trigger

Apply this contract when code creates, controls, restores, terminates, or
persists a task, including workspace policy, concurrency, mobile operation-id
deduplication, SDK approvals, and manual Agent shutdown.

The Agent stores task metadata and the SDK session reference only. Instructions,
assistant output, tool inputs, and Claude transcript history never enter the
task tables, idempotency result, or audit record.

### 2. Signatures

```ts
new TaskManager({ sqlite, settingsRepository }).recoverFromUnexpectedRestart();

manager.createTask({
  deviceId,
  operationId,
  initialCwd,
  model, // optional
  permissionMode,
  workspaceRiskAccepted,
});
manager.submitInstruction({ deviceId, operationId, taskId, instruction });
manager.resolveApproval({ deviceId, operationId, taskId, approvalId, decision });
manager.interruptTask({ deviceId, operationId, taskId });
manager.closeTask({ deviceId, operationId, taskId });
manager.resumeTask({ deviceId, operationId, taskId });
manager.setModel({ deviceId, operationId, taskId, model });
manager.setPermissionMode({ deviceId, operationId, taskId, permissionMode });
manager.shutdown();
```

`task-runtime` settings are Zod-validated through `SettingsRepository` and
contain `{ concurrentTaskCapacity, workspaceRoots }`. The initial capacity is
three and no workspace root is authorized by default.

### 3. Contracts

- Persist only `idle`, `executing`, `awaiting_approval`, `interrupted`, and
  `terminal` task states. The normal path is `idle -> executing ->
  awaiting_approval -> executing -> idle`.
- Only `executing` and `awaiting_approval` count towards capacity. A new task
  is rejected immediately when active work is at capacity; an instruction is
  also rejected if previously created idle sessions would exceed the limit.
- Canonicalize both the selected initial directory and configured roots before
  the descendant check. The root list authorizes only the initial `cwd`; it is
  not a filesystem sandbox. Require `workspaceRiskAccepted: true` before any
  task row is created.
- A task owns one long-lived SDK input stream while its live session exists.
  Open an idle/recovered session lazily, passing persisted `model`,
  `permissionMode`, and `sdkSessionId` as SDK options. Never recreate an SDK
  transcript in Agent storage.
- Per-task normal controls run in arrival order. `interruptTask` and
  `closeTask` bypass that ordinary lane. Close cancels a pending approval,
  interrupts and closes the SDK session, and persists `terminal` before it
  waits for cancellation completion.
- An approval uses the SDK request ID as its task-scoped approval ID. Approval
  waits without an Agent timeout. Interrupt, close, SDK abort, or a stale ID
  cancels/rejects that deferred decision.
- Persist each successful mobile state-changing result for 24 hours by
  `(deviceId, operationId)` and return its original metadata-only result on a
  retry. Write exactly one matching audit row without prompt, output, tool, or
  secret data.
- At process startup turn unfinished `executing` and `awaiting_approval` rows
  into `interrupted`. `resumeTask` requires a saved SDK session ID, opens with
  `Options.resume`, and changes to `idle` without replaying an instruction.
  Existing idle rows remain idle. Manual `TaskManager.shutdown()` cancels all
  live SDK/approval resources and marks every non-terminal row terminal before
  storage closes.
- `TaskEventJournal` assigns monotonic in-memory task cursors, sends each
  event to current subscribers, and retains only the active turn. It keeps a
  small memory prefix, encrypts later `event_overflow` rows with the existing
  record-specific AES-GCM context, and deletes both stores at turn end.
  At 256 MiB it sends `EVENT_REPLAY_STORAGE_LIMIT_REACHED` live and stops
  retaining later events without stopping the task.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| `workspaceRiskAccepted` is false | `WORKSPACE_SCOPE_RISK_NOT_ACCEPTED`; create no task. |
| Canonical initial cwd is not a configured root/descendant | `WORKSPACE_NOT_AUTHORIZED`; create no task. |
| Active work meets configured capacity | `CONCURRENT_TASK_LIMIT_REACHED`; never queue work. |
| Permission mode is absent from installed SDK capability data | `UNSUPPORTED_PERMISSION_MODE`; never fall back. |
| Instruction/model change during a current turn | `TASK_BUSY`; model change is not queued. |
| Instruction/interrupt/permission change before explicit recovery | `TASK_INTERRUPTED`; only resume can reopen it. |
| Approval ID is no longer pending | `STALE_APPROVAL`; never resolve the SDK callback. |
| Close or any later control against terminal state | `TASK_TERMINAL`; no SDK work restarts. |
| Resume has no persisted SDK session reference | `TASK_SESSION_UNAVAILABLE`; do not invent a new transcript. |
| Replay buffer reaches its per-task budget | Send `EVENT_REPLAY_STORAGE_LIMIT_REACHED` live; retain no later replay data. |

### 5. Good / Base / Bad Cases

- Good: two idle tasks share an authorized directory, one starts a turn and
  becomes active, and both retain independent SDK/session metadata.
- Base: a fresh Agent has no roots, so every task creation is rejected until a
  localhost administrator configures one and the mobile user accepts its
  non-sandbox risk.
- Bad: treating an idle session as active capacity, storing an instruction in
  `operation_results`, waiting behind a model change before honoring close, or
  submitting the interrupted instruction when a task resumes.

### 6. Tests Required

- Unit-test risk acknowledgement, real/canonical root descendant checks,
  same-directory tasks, idle exclusion from capacity, and active capacity
  rejection.
- Unit-test operation retries return the first result and create one audit row
  with no instruction content.
- Unit-test user interrupt cancels approval, stale approval rejection, idle
  model changes, and permission-mode forwarding while execution continues.
- Unit-test active-state recovery, resume-option forwarding without a replayed
  message, close priority, and manual runtime shutdown turning idle and active
  rows terminal.
- Unit-test memory replay ordering, encrypted SQLite overflow round-trip,
  cap notification/live delivery, and cleanup after idle or terminal state.

### 7. Wrong vs Correct

#### Wrong

```ts
if (task.state !== "idle") throw new Error("busy");
await queuedModelChange;
await session.interrupt();
task.state = "terminal";
```

The queued operation delays an explicit close and gives it lower priority than
ordinary control work.

#### Correct

```ts
pendingApproval?.cancel("The user closed this task.");
persistTaskState(taskId, "terminal");
const interrupt = session.interrupt();
session.close();
await Promise.allSettled([interrupt]);
```

Persist terminal state immediately after cancellation begins, bypass the normal
task lane, and never let a late SDK completion reopen the task.
