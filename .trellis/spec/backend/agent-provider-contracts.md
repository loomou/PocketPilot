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

taskManager.providerTaskRuntime(): ProviderTaskRuntime;

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
POST /v1/providers/{providerId}/conversations/{conversationId}/fork
POST /v1/providers/{providerId}/conversations/{conversationId}/archive
POST /v1/providers/{providerId}/conversations/{conversationId}/unarchive
POST /v1/providers/{providerId}/conversations/{conversationId}/delete
GET  /v1/tasks/{taskId}/agent
```

Conversation list may accept optional provider-supported filters such as
`includeArchived=true` and `searchTerm`. Conversation lifecycle mutations stay
on these REST routes; do not invent Agent WebSocket wrappers for fork, archive,
unarchive, or delete.

### 3. Contracts

- Register every configured provider, including unavailable providers. Status is
  one of `available`, `not_installed`, `disabled`, `unhealthy`, or
  `unsupported_version`; unavailable providers remain discoverable.
- Readiness is a bounded, cached probe—not a continuous health daemon:
  - Adapters may implement `refreshReadiness({ force? })`. Discovery routes
    (`GET /v1/providers`, `GET /v1/providers/{providerId}/capabilities`) refresh
    stale readiness before returning descriptors/capabilities.
  - Default cache TTL is `PROVIDER_READINESS_TTL_MS` (30s). Concurrent refresh
    for one provider must single-flight.
  - Install-presence-only constructor snapshots are provisional and must still
    run the first version/protocol probe; only intentionally configured
    `disabled` may skip probing as a cached decision.
  - Stable non-secret reason codes include:
    - Codex: `CODEX_COMMAND_NOT_FOUND`,
      `CODEX_APP_SERVER_VERSION_UNSUPPORTED`,
      `CODEX_APP_SERVER_PROBE_FAILED`
    - Claude: `CLAUDE_SDK_NOT_AVAILABLE`,
      `CLAUDE_SDK_VERSION_UNSUPPORTED`,
      `CLAUDE_SDK_PROBE_FAILED`
  - Probes are timeboxed and must clean up short-lived children in `finally`.
    Never return executable/config paths, env dumps, raw stderr, credentials,
    or stack traces in descriptors.
- Descriptor responses project only stable fields: `id`, `displayName`,
  `status`, optional `reasonCode`, optional `protocolVersion`, and the exact
  capability fields. Never return executable/config paths, credentials, raw
  process errors, environment values, or unrecognized adapter fields.
- Capability snapshots always include boolean `attachments`, a closed
  `nativeActions` object, a closed `statusCatalogs` object, and a closed
  `threadManagement` object. The sanitizer admits only the reviewed
  native-action keys `review`, `rename`, and `compact` and rewrites each
  descriptor to a closed shape before publication:
  - `review`: `{ availability: "idle", deliveries: ["inline"], method,
    startsTurn: true, targetTypes: ["uncommittedChanges", "baseBranch",
    "commit", "custom"] }`
  - `rename`: `{ availability: "always", method, startsTurn: false }`
  - `compact`: `{ availability: "idle", method, startsTurn: true }`
  The sanitizer also admits only the reviewed status-catalog keys `account`,
  `rateLimits`, `skills`, `hooks`, and `mcpServers`, each rewritten as
  `true` when present. The sanitizer admits only the reviewed
  thread-management keys `archive`, `delete`, `fork`, `includeArchived`,
  `search`, and `unarchive`, each rewritten as a boolean. Unknown action keys,
  unknown status-catalog keys, unknown thread-management keys, extra descriptor
  fields, and open-ended catalogs are dropped. Capability metadata is
  descriptive only; execution remains on the reviewed REST or native Agent
  WebSocket surface and never invents unreviewed mutation routes.
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
  `{ page: { cursor, hasMore } }`. Conversation rows, history rows, errors,
  client frames, native approval requests, and native approval responses remain
  provider-native.
- `/v1/tasks/{taskId}/agent` selects the adapter from the persisted task. It
  installs the native subscriber before activation and transports JSON frames
  without `{ kind: "agent", payload: ... }` or another synthetic wrapper.
- `/v1/events` remains the independent PocketPilot control stream. Task state,
  task IDs, and control cursors never enter provider-native frames. A provider
  approval may additionally project a metadata-only `approval.requested`
  control event, but the client must still answer with the provider's unchanged
  native response frame on the Agent WebSocket.
- Provider adapters use `ProviderTaskRuntime` for shared P2 serialization,
  active-task capacity, generation invalidation, task-state transitions,
  approval projection, and turn retention. Do not build a second scheduler or
  capacity counter inside an adapter.
- Provider-native catalog and history reads are P3. They remain outside the P2
  task lane, reject unavailable/interrupted/terminal tasks, and recheck current
  workspace authorization before forwarding or returning data.
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
| A P3 read targets an interrupted, terminal, or revoked task | Reject with the existing task/workspace error; forward no provider request. |
| A queued P2 operation is invalidated by P0/P1 | `409 TASK_OPERATION_SUPERSEDED`; perform no later provider write or task-state update. |
| Agent WebSocket authentication fails | Close `4003 / AUTHENTICATION_FAILED`; register no socket. |
| Native client frame is invalid | Close `4000 / SDK_MESSAGE_INVALID`; submit nothing. |
| Task is missing or its runtime is unavailable | Close `4004 / TASK_NOT_FOUND` or `4009 / TASK_SESSION_UNAVAILABLE`. |
| Native transport fails unexpectedly | Close `4011 / SDK_TRANSPORT_FAILED`; expose no process/SDK exception text. |

### 5. Good / Base / Bad Cases

- Good: a fake provider is registered and exercised through every common route
  without a provider-ID branch in route or runtime code.
- Good: an unavailable provider exposes a stable reason code but no local path
  or raw process diagnostics.
- Good: concurrent discovery refreshes single-flight one Codex initialize probe
  and reuse the cached result within the TTL.
- Good: a provider turn reserves shared capacity through `ProviderTaskRuntime`,
  while a native history read proceeds as P3 without waiting behind that turn's
  P2 lane.
- Conversation create/attach/fork return bound task operation results with a
  non-null `task`. Archive/unarchive/delete return null-task results
  (`{ action: "archived" | "unarchived" | "deleted", task: null }`).
- Archive and delete require explicit `confirm: true`. Missing or false confirm
  returns `409 CONFIRMATION_REQUIRED` from the adapter/runtime, not a request
  schema failure.
- Fork creates/reuses a PocketPilot task for the **new** native conversation.
  Archive is reversible and must not auto-close bound tasks. Delete of a
  currently bound non-terminal task conversation closes that task only after
  native delete succeeds.
- Codex publishes `attachments: false`, closed `nativeActions` for
  review/rename/compact, closed `statusCatalogs` for
  account/rateLimits/skills/hooks/mcpServers, and closed `threadManagement`
  for archive/delete/fork/includeArchived/search/unarchive. Claude publishes
  empty/false equivalents until a reviewed surface lands.
- Base: Claude list/history rows retain object identity while their native
  offset/UUID cursors appear only in the common page envelope.
- Bad: a route switches on `providerId === "claude"`, wraps native frames, lets
  the adapter authorize paths, or silently hides a missing provider.
- Bad: advertising `attachments: true` or open-ended native action catalogs
  before a reviewed remote transport exists.

### 6. Tests Required

- Registry tests cover every availability status, duplicate IDs, safe
  descriptor projection, closed `nativeActions` sanitization, closed
  `statusCatalogs` sanitization, unknown providers, and unavailable execution.
- Readiness tests cover TTL caching, single-flight concurrent refresh,
  provisional install-presence snapshots that still probe, disabled skip
  behavior, stable reason codes without path/secret leakage, discovery route
  refresh before descriptor/capability responses, and probe-child cleanup.
- Fake-provider route tests cover authentication, common workspace rejection,
  list/read/create/attach delegation, native row passthrough, capability
  schema fields (`attachments`, `nativeActions`, `statusCatalogs`), and
  operation metadata.
- OpenAPI tests assert capability schemas include `attachments`, the closed
  `nativeActions` action descriptors, and the closed `statusCatalogs`
  descriptors.
- Agent WebSocket tests cover task/provider selection, subscribe-before-
  activation, bidirectional native equality, invalid/binary input, replay
  cursor forwarding, stable close codes, device revocation, and task-only close.
- Provider adapter tests cover shared capacity, queued P2 invalidation by P0/P1,
  P3 progress outside a blocked P2 lane, workspace reauthorization, approval
  projection, and native approval-response ownership.
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
