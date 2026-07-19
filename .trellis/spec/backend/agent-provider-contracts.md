# Agent Provider Contracts

## Scenario: Provider-Extensible Native Agent API

### 1. Scope / Trigger

Apply this contract when registering an Agent provider, exposing provider
status/capabilities, listing or attaching conversations, binding a task to a
provider, or transporting provider-native frames. Common PocketPilot code owns
security and lifecycle policy; adapters own native protocols.

### 2. Signatures

```ts
new AgentProviderRegistry(adapters: readonly AgentProviderAdapter[]);
registry.descriptors(): AgentProviderDescriptor[];
registry.descriptor(providerId): AgentProviderDescriptor;
registry.requireAvailable(providerId): AgentProviderAdapter;

new AgentRuntimeManager(registry, {
  authorizeWorkspace(workspace): Promise<string>;
  getTask(taskId): TaskSnapshot;
});

interface AgentProviderAdapter {
  readonly descriptor: AgentProviderDescriptor;
  readonly taskStream: AgentTaskStreamAdapter;
  listConversations(input): Promise<AgentConversationPage<unknown>>;
  readConversation(input): Promise<AgentConversationPage<unknown>>;
  createConversation(input): Promise<TaskOperationResult>;
  attachConversation(input): Promise<TaskOperationResult>;
}
```

Public routes are:

```text
GET  /v1/providers
GET  /v1/providers/{providerId}/capabilities
GET  /v1/providers/{providerId}/conversations
POST /v1/providers/{providerId}/conversations
GET  /v1/providers/{providerId}/conversations/{conversationId}
POST /v1/providers/{providerId}/conversations/{conversationId}/attach
GET  /v1/tasks/{taskId}/agent
```

### 3. Contracts

- Register every configured provider, including unavailable providers. Status is
  one of `available`, `not_installed`, `disabled`, `unhealthy`, or
  `unsupported_version`; unavailable providers remain discoverable.
- Descriptor responses project only stable fields: `id`, `displayName`,
  `status`, optional `reasonCode`, optional `protocolVersion`, and the exact
  capability fields. Never return executable/config paths, credentials, raw
  process errors, environment values, or unrecognized adapter fields.
- Provider installation, enablement, and configuration are local-admin-only.
  The remote provider API is read-only for status and capabilities.
- `AgentRuntimeManager` resolves provider availability and canonicalizes the
  requested workspace through `TaskManager.authorizeWorkspace` before invoking
  any adapter conversation method. An adapter must not become an authorization
  policy owner.
- A task stores immutable `provider` and `nativeProtocolVersion` values.
  Provider-native conversation IDs remain separate; Claude continues using its
  `sdkSessionId` field until a provider-neutral native identity store is
  introduced by a separately reviewed migration.
- Common response envelopes contain only task/provider metadata and
  `{ page: { cursor, hasMore } }`. Conversation rows, history rows, approvals,
  errors, client frames, and server frames remain provider-native.
- `/v1/tasks/{taskId}/agent` selects the adapter from the persisted task. It
  installs the native subscriber before activation and transports JSON frames
  without `{ kind: "agent", payload: ... }` or another synthetic wrapper.
- `/v1/events` remains the independent PocketPilot control stream. Task state,
  approvals, task IDs, and control cursors never enter provider-native frames.
- The Claude adapter validates the raw base message but submits the same parsed
  object reference, preserving extension fields. It converts only pagination
  cursors outside native rows.
- The old `/v1/sessions` and `/v1/tasks/{taskId}/sdk` routes are removed in the
  direct cutover; do not add aliases, redirects, or compatibility facades.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Duplicate provider ID | Fail registry construction before listener startup. |
| Unknown provider | `404 AGENT_PROVIDER_NOT_FOUND`. |
| Registered but unavailable provider | `409 AGENT_PROVIDER_UNAVAILABLE`; discovery still returns its safe descriptor. |
| Workspace is missing or outside authorized roots | Existing `403 WORKSPACE_NOT_AUTHORIZED`; adapter is not called. |
| Agent WebSocket authentication fails | Close `4003 / AUTHENTICATION_FAILED`; register no socket. |
| Native client frame is invalid | Close `4000 / SDK_MESSAGE_INVALID`; submit nothing. |
| Task is missing or its runtime is unavailable | Close `4004 / TASK_NOT_FOUND` or `4009 / TASK_SESSION_UNAVAILABLE`. |
| Native transport fails unexpectedly | Close `4011 / SDK_TRANSPORT_FAILED`; expose no process/SDK exception text. |

### 5. Good / Base / Bad Cases

- Good: a fake provider is registered and exercised through every common route
  without a provider-ID branch in route or runtime code.
- Good: an unavailable provider exposes a stable reason code but no local path
  or raw process diagnostics.
- Base: Claude list/history rows retain object identity while their native
  offset/UUID cursors appear only in the common page envelope.
- Bad: a route switches on `providerId === "claude"`, wraps native frames, lets
  the adapter authorize paths, or silently hides a missing provider.

### 6. Tests Required

- Registry tests cover every availability status, duplicate IDs, safe
  descriptor projection, unknown providers, and unavailable execution.
- Fake-provider route tests cover authentication, common workspace rejection,
  list/read/create/attach delegation, native row passthrough, and operation
  metadata.
- Agent WebSocket tests cover task/provider selection, subscribe-before-
  activation, bidirectional native equality, invalid/binary input, replay
  cursor forwarding, stable close codes, device revocation, and task-only close.
- Claude adapter tests cover offset and history cursor conversion, unchanged
  native row identity, create/attach delegation, raw parse/submit identity,
  subscribe forwarding, and activation.
- OpenAPI tests assert the new path set and prove both removed routes are absent.

### 7. Wrong vs Correct

#### Wrong

```ts
if (providerId === "claude") {
  socket.send(JSON.stringify({ kind: "agent", payload: sdkMessage }));
}
```

This puts provider knowledge in a common route and creates a second wire
protocol.

#### Correct

```ts
const provider = runtime.taskProvider(taskId);
const unsubscribe = provider.taskStream.subscribe(taskId, afterCursor, subscriber);
await provider.taskStream.activate(taskId);
```

The task binding chooses the adapter, and that adapter preserves its native
protocol while PocketPilot retains authentication and lifecycle ownership.
