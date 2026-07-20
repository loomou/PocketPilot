# Task Runtime Contracts

## Scenario: Persistent Tasks with Separate Agent and Control Transports

### 1. Scope / Trigger

Apply this contract when code creates, controls, restores, terminates, or
persists a task; accepts provider-native user messages; publishes Agent/control
traffic; handles approvals; or changes active-turn replay.

The Agent stores task metadata and the SDK session reference only. SDK input,
assistant output, tool input/output, and Claude transcript history never enter
task rows, operation results, audit content, or logs.

### 2. Signatures

```ts
runtime.listProviders(): AgentProviderDescriptor[];
runtime.providerCapabilities(providerId): AgentProviderDescriptor;
runtime.listConversations(providerId, { workspace, limit?, cursor? });
runtime.readConversation(providerId, {
  workspace, nativeConversationId, limit?, cursor?, includeSystemMessages?,
});
runtime.createConversation(providerId, input);
runtime.attachConversation(providerId, input);
runtime.taskProvider(taskId): AgentProviderAdapter;

manager.createTask({
  deviceId, operationId, initialCwd, model, permissionMode,
  workspaceRiskAccepted,
});
manager.createClaudeConversation({
  deviceId, operationId, workspace, workspaceRiskAccepted,
});
manager.attachClaudeSession({
  deviceId, operationId, workspace, workspaceRiskAccepted, sessionId,
});
manager.listClaudeSessions({ workspace, limit?, offset? });
manager.readClaudeSessionHistory({
  workspace, sessionId, limit?, beforeUuid?, includeSystemMessages?,
});
manager.authorizeWorkspace(workspace): Promise<string>;
manager.activateSdkSession(taskId);
manager.getComposerOptions(taskId);
manager.authorizedWorkspaceRoots(): readonly string[];
manager.authorizedDirectorySnapshot(): Promise<AuthorizedDirectorySnapshot>;
manager.addAuthorizedDirectory({
  selectedPath, volumeRootRiskAccepted,
}): Promise<AddAuthorizedDirectoryResult>;
manager.removeAuthorizedDirectory({
  path, revision, expectedNonTerminalRuntimeCount, runtimeStopAccepted,
}): Promise<RemoveAuthorizedDirectoryResult>;
manager.submitSdkMessage({ deviceId, taskId, message: SDKUserMessage });
manager.resolveApproval({
  deviceId, operationId, taskId, requestId, result: PermissionResult,
});
manager.interruptTask({ deviceId, operationId, taskId });
manager.closeTask({ deviceId, operationId, taskId });
manager.resumeTask({ deviceId, operationId, taskId });
manager.setModel({ deviceId, operationId, taskId, model });
manager.setPermissionMode({ deviceId, operationId, taskId, permissionMode });
manager.setEffortLevel({ deviceId, operationId, taskId, effortLevel });
manager.shutdown();

manager.providerTaskRuntime(): ProviderTaskRuntime;

interface ProviderTaskRuntime {
  run(taskId, operationWithLease): Promise<unknown>;
  assertReadable(taskId): Promise<TaskSnapshot>;
  reserveTurn(taskId, lease): Promise<TaskSnapshot>;
  rollbackTurn(taskId): TaskSnapshot | undefined;
  turnStarted(taskId, nativeTurnId): TaskSnapshot | undefined;
  turnCompleted(taskId): TaskSnapshot | undefined;
  beginInterrupt(taskId): TaskSnapshot;
  completeInterrupt(taskId): TaskSnapshot | undefined;
  approvalRequested(taskId, request): TaskSnapshot | undefined;
  approvalResolved(taskId, pendingRequestCount): TaskSnapshot | undefined;
}

journal.publishSdkMessage(taskId, message: SDKMessage): void;
journal.subscribeSdk(taskId, afterUuid, subscriber): Unsubscribe;
journal.publishControlEvent(taskId, event): TaskControlEventEnvelope;
journal.subscribeControl(taskId, afterCursor, subscriber): Unsubscribe;
```

Remote conversation transport is the bidirectional provider-native
`GET /v1/tasks/{taskId}/agent` WebSocket. `GET /v1/events` is the independent
PocketPilot control WebSocket. Provider discovery and conversation resources
are under `/v1/providers/{providerId}`. `GET /v1/workspaces` returns configured
authorized roots. `/v1/tasks/{taskId}/instruction` does not exist.

### 3. Contracts

- Persist only `idle`, `executing`, `awaiting_approval`, `interrupted`, and
  `terminal`. The common path is `idle -> executing -> awaiting_approval ->
  executing -> idle`.
- Persist immutable `provider` and `nativeProtocolVersion` alongside task
  origin `pocketpilot` or `claude-session`. Explicit task rows
  keep their initial model and permission mode. Session-centric rows keep
  `model` and `permissionMode` null so Claude Code resolves/restores its own
  settings; `sdkSessionId` is null only until a new Query emits its unchanged
  `system/init` message.
- Enforce one non-terminal task for each non-null SDK session ID with the
  partial unique index `tasks_live_sdk_session_id_unique`. The migration keeps
  the newest legacy owner and terminalizes older duplicates before creating
  the index. Attachment also runs on one manager lane and reuses the winner.
- A task owns one long-lived provider-native input stream and runtime while its
  live session exists. Lazily open idle/recovered sessions with provider-owned
  metadata and native IDs; never recreate a transcript.
- A raw Agent frame has no PocketPilot `operationId` and is outside the 24-hour
  HTTP operation-result cache. After accepting it, write one metadata-only
  audit record with device ID, task ID, operation name, and result only.
- An idle message with `shouldQuery !== false` reserves capacity, begins
  active-turn retention, and changes the task to `executing`. An idle
  `shouldQuery: false` message is appended to the same SDK session without
  inventing a turn or consuming active capacity.
- Accept SDK messages while `executing` or `awaiting_approval`. Serialize
  simultaneous socket callbacks only to retain arrival order; never return
  `TASK_BUSY` merely because a turn or approval is active. Preserve SDK
  `priority` and `shouldQuery` unchanged; PocketPilot's P0-P3 runtime tiers
  control admission/preemption only and never reinterpret SDK scheduling data.
- Count query-triggering messages only for lifecycle accounting. A result
  boundary advances retained-turn ownership; the task becomes idle after the
  outstanding SDK query boundaries or authoritative SDK idle state, without
  changing SDK queuing behavior.
- Only `executing` and `awaiting_approval` count toward configured capacity.
  Canonicalize selected cwd and configured roots, require
  `workspaceRiskAccepted: true`, and remember that roots authorize initial cwd
  but are not a filesystem sandbox.
- Session catalog, history, new-conversation, and attachment requests
  canonicalize the selected workspace through `authorizeWorkspace` in the
  provider-neutral runtime before calling an adapter. Claude methods retain
  their own policy checks as a defense in depth. Catalog
  calls explicitly set `includeWorktrees: false` and
  `includeProgrammatic: true`; present SDK session cwd values must canonicalize
  inside the selected workspace before metadata, history, or attachment is
  allowed.
- List pagination returns provider-native rows under the common
  `{ page: { cursor, hasMore } }` envelope. Claude advances its offset by SDK
  rows consumed, including rows filtered by cwd policy. History first validates
  with `getSessionInfo`, then returns unchanged chronological `SessionMessage`
  rows: the latest 50 initially and up to 50 before the earliest loaded UUID.
  Same-session history reads use a dedicated serial lane and retain no
  transcript cache.
- New conversation and selected-session attachment create idle internal
  runtimes without reserving active-turn capacity. Selecting a session is the
  continuation action; no public task-resume step or prompt replay is added.
  The raw WebSocket subscribes first and then calls `activateSdkSession`, which
  opens `claude-session` Queries with no PocketPilot model/permission/effort
  override and sets `Options.resume` only for an existing SDK session.
- Composer options expose SDK `ModelInfo[]`, pinned SDK permission modes, and
  the allowlisted resolved effort only after Query activation. Model,
  permission-mode, and effort controls share the per-task input lane, may run
  while a turn is active, and affect the next turn. A client awaits the
  control response before Send when command-before-prompt order matters.
- `GET /v1/workspaces` requires the existing Bearer access credential and
  returns `{ workspaceRoots: string[] }` from the same Zod-validated
  `task-runtime` settings used by task creation. Return a new array, expose no
  other local settings, and do not duplicate settings/SQLite reads in the
  route. These are configured roots; task creation still performs canonical
  existence and descendant authorization checks.
- The loopback administration surface is the only workspace-root writer.
  Canonical roots use Windows case-insensitive, component-boundary containment;
  duplicate aliases and covered children collapse to one minimal root set.
  Existing unresolvable roots remain visible/removable but authorize no new
  work. A volume or UNC share root requires explicit high-risk acceptance.
- Root addition/removal re-reads the complete latest task setting immediately
  before its synchronous transaction. Comparing only `workspaceRoots` is not
  enough: a concurrent capacity save must be preserved in that same record.
- Removing a root is P0. One SQLite transaction writes the remaining roots and
  terminalizes every uncovered non-terminal task before asynchronous SDK
  cleanup. It then invalidates queued P2 work, cancels approval, ends replay,
  closes affected provider-native Agent sockets with `4009`, and
  interrupts/closes live
  Queries. Reauthorizing a path never resurrects an old terminal handle.
- Runtime priority is explicit: P0 is shutdown/close/root revocation, P1 is
  interrupt, P2 is raw Send/approval/model/mode/effort/activation/composer/
  resume, and P3 is catalog/history/status/config reads. P0/P1 synchronously
  advance the task operation generation and reject older queued P2 work before
  awaiting SDK cleanup. P1 first persists `interrupted`, then returns the same
  Query to `idle`; P0 leaves `terminal`. New P2 is rejected during P1 cleanup
  and may run on the new generation after cleanup even if an already-handed
  stale SDK call has not settled.
- Non-Claude adapters must enter P2 work through `ProviderTaskRuntime.run()` and
  call `lease.assertCurrent()` before and after every awaited native boundary.
  Query-triggering native starts call `reserveTurn()` before forwarding so the
  same capacity counter covers every provider. That includes Codex
  `turn/start`, inline `review/start`, and `thread/compact/start`. Forward or
  pre-authoritative native-start failure calls `rollbackTurn()`; once
  `turnStarted()` has made a turn authoritative, late request errors must not
  roll the turn back. Authoritative native notifications call `turnStarted()`
  and `turnCompleted()`.
- Provider-native non-turn P2 actions (for example Codex `thread/name/set`) may
  run through the shared P2 lane without calling `reserveTurn()`. They still
  require a current lease and task availability, but they do not consume active
  capacity or invent a turn.
- When a provider marks a turn kind non-steerable (Codex review/compact), the
  adapter rejects mid-turn steering while preserving interrupt against the
  current active turn ID. Runtime-only turn-kind state is never persisted into
  task rows.
- Provider P3 reads use `assertReadable()` outside the P2 lane. It rejects
  interrupted, terminal, closed, interrupting, and shutting-down runtimes and
  rechecks the task's current workspace authorization before data is exposed.
  Adapters recheck around activation and native forwarding because P0 may revoke
  the workspace between awaits.
- Idempotent HTTP controls use the 24-hour `(deviceId, operationId)` cache.
  Superseded operations persist an error tombstone, so a retry after P1/P0
  returns `TASK_OPERATION_SUPERSEDED` instead of running on a newer generation.
  P3 reads stay outside the Query lane and recheck current workspace policy
  before returning session data or persisting a runtime.
- An approval uses the SDK `requestId`. The control payload is
  `{ toolName, input, options: Omit<CanUseToolOptions, "signal"> }`; the HTTP
  resolution request uses the path `requestId` plus body
  `{ operationId, result: PermissionResult }`, and its response is the shared
  `TaskOperationResult` metadata shape `{ action, task }`. Return the submitted
  result unchanged to the deferred callback without echoing it in the response.
- A non-Claude provider approval moves only an active task to
  `awaiting_approval` and emits
  `{ provider, requestId, method, params }` on the control stream. Resolving the
  last known request returns the task to `executing`; an unknown resolution on
  an idle/interrupted/terminal task never resurrects it. Provider adapters own
  native request IDs, device/generation binding, and unchanged native response
  frames.
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
| Model, permission, or effort changes while active | Forward through the live Query; accepted values apply to the next turn. |
| Approval request ID is stale | `STALE_APPROVAL`; never resolve another SDK callback. |
| Resume lacks an SDK session reference | `TASK_SESSION_UNAVAILABLE`; do not invent a transcript. |
| Selected SDK session is absent or cannot be proven inside the workspace | `CLAUDE_SESSION_NOT_FOUND`; reveal no other local path. |
| History UUID is absent from the current filtered chain | `HISTORY_CURSOR_STALE`; reload the latest page. |
| SDK transcript read fails | `CLAUDE_HISTORY_UNAVAILABLE`; keep the attached Query/composer usable. |
| A second non-terminal runtime would own one SDK session | `CLAUDE_SESSION_CONFLICT`; start no second Query. |
| Picker-selected volume root lacks explicit acceptance | `VOLUME_ROOT_RISK_NOT_ACCEPTED`; write no setting. |
| Root removal revision or affected-runtime count changed | `AUTHORIZED_DIRECTORY_SNAPSHOT_STALE`; stop no task and require a fresh confirmation. |
| Older P2 reaches a lease checkpoint after P0/P1 | `TASK_OPERATION_SUPERSEDED`; persist a rejecting tombstone and perform no later state write. |
| Provider P3 read targets an interrupted/closed/interrupting runtime | `TASK_SESSION_UNAVAILABLE`; perform no native read. |
| Provider turn start exceeds shared active capacity | `CONCURRENT_TASK_LIMIT_REACHED`; forward no native start frame. |
| Native turn start fails after reservation | Roll back to `idle`, end retained replay, and release capacity. |
| Unknown provider approval resolution arrives while idle | Keep `idle`; never change the task to `executing`. |
| Replay reaches 256 MiB | Notify control subscribers, retain no later records, and continue live SDK/control delivery. |

### 5. Good / Base / Bad Cases

- Good: a task accepts two SDK user messages during execution, preserves their
  scheduling fields, emits raw Query messages on only its SDK socket, and
  remains active across both SDK result boundaries.
- Good: root revocation commits the policy and terminal task rows, closes that
  task's raw socket, keeps the control socket connected, and only then awaits
  best-effort Query interruption.
- Base: P1 invalidates a blocked model change; a new-generation permission
  change runs after cleanup without waiting for the stale SDK promise.
- Good: a Codex turn and a Claude query share one configured capacity limit;
  interrupting the Codex turn invalidates queued P2 frames before native cleanup
  begins.
- Base: a provider catalog read proceeds outside a blocked P2 lane, but fails if
  root revocation wins before its final authorization check.
- Good: selecting a validated SDK session returns its existing opaque task
  handle, the raw subscriber receives original `system/init`, and a later raw
  user message continues through `Options.resume`.
- Base: a long history opens on its latest 50 messages; upward pagination uses
  the earliest UUID, virtualized clients prepend older rows, and PocketPilot
  never stores or resends the history.
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
- Test P0 root revocation for idle/executing/approval/interrupted tasks,
  capacity/root lost-update prevention, stale confirmation, parent/child root
  normalization, and volume-root confirmation.
- Test P1/P0 generation invalidation, new-generation progress while a stale SDK
  call remains pending, persisted superseded retries, and close-vs-interrupt.
- Test provider P2 lease checkpoints, shared cross-provider capacity, failed
  native-start rollback, P3 progress outside a blocked lane, P3 workspace
  reauthorization, and idle-state protection from unknown approval resolution.
- Route-test that P0 closes only the selected provider-native task socket with `4009`
  while a device control socket remains connected.
- Test SDK catalog option forwarding and cwd filtering; unchanged latest/older
  history pages, stale cursors, system-message mode, serial reads, and history
  failure independent from Query activation.
- Test new-conversation defaults, transparent attachment/reuse, migration and
  runtime uniqueness, subscribe-before-activate raw init delivery, composer
  discovery, and active-turn model/mode/effort sequencing.

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
await taskLane.run(async (lease) => {
  lease.assertCurrent();
  await session.setModel(selectedModel);
  lease.assertCurrent();
  session.submit(sdkUserMessage);
});
recordMetadataOnlyAudit(deviceId, taskId, "task.sdk-message-submitted");
return sessionMessagePage; // unchanged SDK rows + out-of-band page metadata
```

The lane preserves control/input order only; the SDK controls scheduling and
the Agent records no message or history content.
