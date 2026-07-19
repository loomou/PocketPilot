# Provider-extensible Agent API design

## Architecture

```text
Mobile client
  |  common Agent API + provider-native task stream
  v
Remote API
  |-- provider discovery and capability routes
  |-- common workspace/conversation/task routes
  |-- common Agent conversation/task routes
  `-- task-scoped native stream
          |
          v
AgentRuntimeManager (provider-neutral orchestration)
  |-- ProviderRegistry
  |      |-- ClaudeProviderAdapter -> Claude SDK Query
  |      |-- CodexProviderAdapter  -> Codex App Server bridge
  |      `-- future OpenCode/Pi adapters
  |-- provider-aware task repository
  |-- common priority/idempotency/auth policy
  `-- provider event journals

CodexProviderAdapter
  |-- CodexThreadCatalog
  |-- CodexTurnController
  |-- CodexApprovalRegistry
  `-- CodexAppServerBridge -> local `codex app-server` stdio JSONL
```

The common layer owns PocketPilot security and runtime behavior. Each adapter
owns its Agent's native IDs, protocol, history rows, turn semantics, controls,
events, approvals, and error details. A new provider should be added by
implementing and registering an adapter, not by adding provider conditionals to
every common route or task method.

## The common Agent API

The common API standardizes only concepts guaranteed across local Agents:

- provider discovery and version/capability negotiation;
- authorized workspace selection;
- conversation list, read, create, attach, and resume operations;
- task ownership and lifecycle controls;
- model/mode/effort capability discovery as provider-owned option sets;
- interrupt, close/detach, reconnect, idempotency, and metadata-only audit.

It deliberately does **not** normalize provider history rows, live messages,
streaming deltas, tool events, approval decisions, or error payloads. Those
remain native and are selected by the provider metadata returned before a task
stream is opened.

### Suggested common resource shape

```ts
type AgentProviderId = string;

type AgentProviderDescriptor = {
  id: AgentProviderId;
  displayName: string;
  status:
    | "available"
    | "not_installed"
    | "disabled"
    | "unhealthy"
    | "unsupported_version";
  protocolVersion?: string;
  capabilities?: AgentCapabilities;
  reasonCode?: string;
};

type AgentTaskRef = {
  taskId: string;
  provider: AgentProviderId;
  nativeConversationId: string;
  nativeSessionId?: string;
  nativeProtocolVersion: string;
};

type AgentCapabilities = {
  history: {
    list: boolean;
    read: boolean;
    pagination: "cursor" | "offset" | "none" | "full-read";
    resume: boolean;
    fork: boolean;
  };
  turns: {
    start: boolean;
    steer: boolean;
    interrupt: boolean;
  };
  composer: {
    models: boolean;
    effort: boolean;
    modes: boolean;
    attachments: string[];
  };
  approvals: string[];
  nativeStream: {
    protocol: string;
    version: string;
    reconnect: "provider" | "pocketpilot-sequence" | "none";
  };
};
```

The exact public JSON names can be finalized during implementation, but the
important invariant is that common metadata is small and stable while native
objects are not projected into a false universal schema.

`GET /v1/providers` returns every registered adapter. It does not hide missing,
disabled, unhealthy, or version-incompatible providers. Human-readable local
diagnostics stay in logs; the remote response contains only stable reason codes
and never exposes executable paths, config files, credentials, or raw process
errors. Capabilities are present only when the adapter can produce a trustworthy
snapshot.

Provider enablement is a local-administration concern. The remote API exposes
read-only discovery and capability state; it has no install, enable, disable, or
provider-configuration mutation. This prevents a paired mobile client from
changing the host's executable or account surface while still allowing it to
explain why a provider cannot be used.

## Adapter contract

The adapter contract is intentionally orchestration-oriented rather than a
universal message model:

```ts
interface AgentProviderAdapter {
  readonly descriptor: AgentProviderDescriptor;

  listConversations(input: ListConversationsInput): Promise<unknown>;
  readConversation(input: ReadConversationInput): Promise<unknown>;
  createConversation(input: CreateConversationInput): Promise<AgentAttachment>;
  attachConversation(input: AttachConversationInput): Promise<AgentAttachment>;

  openRuntime(input: OpenRuntimeInput): Promise<AgentRuntimeHandle>;
  sendNative(runtime: AgentRuntimeHandle, frame: unknown): Promise<void>;
  interrupt(runtime: AgentRuntimeHandle): Promise<void>;
  close(runtime: AgentRuntimeHandle): Promise<void>;
}
```

The actual TypeScript contract should use provider-specific generic interfaces
inside each adapter and `unknown` only at the registry boundary. It must not
pretend that Claude `SDKMessage` and Codex JSON-RPC notifications are one type.
Each adapter also supplies its own:

- native frame parser and safe base guard;
- history and live-event codec;
- capability validator;
- pending-approval registry;
- provider error classifier;
- provider test fixture and live contract.

## Public route shape

Introduce common routes without overloading Claude's existing schemas:

```text
GET  /v1/providers
GET  /v1/providers/{providerId}/capabilities
GET  /v1/providers/{providerId}/conversations?workspace=...
POST /v1/providers/{providerId}/conversations
GET  /v1/providers/{providerId}/conversations/{conversationId}
POST /v1/providers/{providerId}/conversations/{conversationId}/attach
GET  /v1/tasks/{taskId}/agent       (provider-native WebSocket)
```

Provider identity is part of the conversation resource path rather than an
optional query parameter. This keeps authorization, adapter selection, OpenAPI
schemas, and future provider-specific extensions unambiguous.

The common HTTP response contains task/provider metadata and out-of-band page
metadata. History rows remain in the selected provider's response schema.
Provider metadata is available before the WebSocket opens, so the client can
select the appropriate native codec without adding a wrapper to each frame.

The old Claude-specific routes (`/v1/sessions` and
`/v1/tasks/{taskId}/sdk`) are removed in the migration cutover. They are not
compatibility facades and must not be kept as a second public API. The new
common routes select the Claude adapter and still emit Claude-native payloads.

The common task controls can remain at `/v1/tasks/{taskId}/interrupt` and
`/close` because they operate on PocketPilot lifecycle. Model, effort, mode, and
approval endpoints must either use provider capability schemas or be exposed by
provider-specific routes when their values are not safely common.

## Native stream contract

The common task stream route resolves the provider from task metadata and then
delegates to the adapter. It provides authentication, task isolation, and an
out-of-band reconnect cursor, but it does not wrap or normalize provider frames:

- Claude sends the same raw `SDKMessage` objects as its existing SDK route.
- Codex sends allowlisted App Server JSON-RPC frames.
- A future OpenCode or Pi adapter sends its own native frame contract.

The control WebSocket remains separate from provider-native traffic. Provider
messages never become `{ kind: "agent", payload: ... }` control events.

## Identity model

| Identifier | Owner | Purpose | Lifetime |
| --- | --- | --- | --- |
| `taskId` | PocketPilot | Authenticated runtime and stream route | One attached runtime channel |
| `provider` | PocketPilot registry | Selects adapter and codec | Task lifetime |
| native conversation ID | Provider | Persisted conversation/branch | Provider-defined |
| native session ID | Provider | Optional session tree/root identity | Provider-defined |
| native turn ID | Provider | One active user request | One turn |
| native item ID | Provider | One message/tool/command/file unit | One item |
| JSON-RPC request ID | Codex App Server | Request correlation and approvals | Until response/resolution |
| replay sequence | PocketPilot | Remote reconnect cursor | Retained active-turn window |

The current Claude `origin` and `sdkSessionId` fields must not be repurposed as
the provider abstraction. Add a provider field and provider-owned runtime
metadata or a separate provider-runtime table. Claude's uniqueness constraint
must continue to apply only to Claude session IDs; Codex and future providers
need their own native-identity constraints.

## Provider-neutral orchestration

`AgentRuntimeManager` should own:

- provider lookup and capability checks;
- workspace authorization and per-task provider selection;
- task creation/attachment ownership;
- P0/P1/P2 scheduling, capacity, idempotency, close, and shutdown;
- common task snapshots and metadata-only audit;
- stream connection registration and provider journal selection.

It should not own:

- Claude input stream details or SDK Query controls;
- Codex active-turn IDs, JSON-RPC request IDs, or multi-approval decisions;
- provider-specific history rows or item reducers;
- provider-specific error fields.

The existing Claude `TaskManager` is migrated behind a `ClaudeProviderAdapter`.
Its native SDK behavior and provider tests remain authoritative, but its old
route contracts are replaced by the common Agent API during the cutover.

## Codex adapter

### Bridge and catalog

`CodexAppServerBridge` starts `codex app-server --listen stdio://`, performs the
`initialize`/`initialized` handshake, parses JSONL, correlates IDs, and routes
notifications/server requests by native `threadId`. It never scrapes terminal
output or sends keyboard input.

`CodexThreadCatalog` owns `thread/start`, `thread/list`, `thread/read`, and
`thread/resume`:

- include `cli`, `vscode`, and `appServer` source kinds;
- preserve opaque cursors and native thread objects;
- canonicalize and filter every returned cwd through workspace policy;
- use experimental turn/item pagination when explicitly supported;
- otherwise use a bounded full-read fallback.

### Turn and item behavior

`CodexTurnController` maps idle input to `turn/start`, active input to
`turn/steer(expectedTurnId)`, and interrupt to `turn/interrupt(threadId, turnId)`.
It does not translate Claude `priority` or `shouldQuery`.

Codex frames retain native `turn/*`, `item/*`,
`item/agentMessage/delta`, `item/completed`, and `turn/completed` semantics.
PocketPilot state is updated only for routing and capacity.

### Approvals

Codex uses a map keyed by App Server JSON-RPC request ID:

```ts
type PendingCodexServerRequest = {
  requestId: string | number;
  method: string;
  taskId: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  deviceScope: string;
};
```

Command, file, permission, MCP elicitation, and user-input requests retain their
method-specific response types and may be pending concurrently. They are not
converted to Claude `PermissionResult` or a single task approval.

## Reconnect and journal model

The common journal abstraction owns active-turn retention, encrypted overflow,
size caps, connection subscriptions, and cleanup. Each provider supplies its
cursor and event identity strategy:

- Claude uses its existing SDK UUID behavior.
- Codex uses an internal monotonic sequence because App Server notifications do
  not provide a universal replay cursor.
- Future providers declare `provider` or `none` cursor behavior in capabilities.

The cursor remains outside provider frames. Unresolved provider server requests
are retained separately and replayed only while still valid.

## Version and capability negotiation

- `GET /v1/providers` reports installed/enabled providers and protocol versions.
- Provider discovery reports `available`, `not_installed`, `disabled`,
  `unhealthy`, or `unsupported_version` for every registered adapter.
- The selected adapter reports stable and experimental capabilities before task
  creation or stream connection.
- Unknown optional capabilities result in explicit unsupported responses rather
  than emulation.
- Codex records `codex --version` and validates the generated App Server schema.
- A future provider can register a different protocol/version without changing
  Claude or Codex frame guards.

## Security and migration cutover

- Every common route authenticates the device and applies workspace policy.
- Provider registration and enablement are writable only through local
  administration; remote clients can only observe the resulting status.
- A task cannot switch provider after creation.
- Native frames are isolated by task and provider; a Claude socket cannot receive
  Codex frames and vice versa.
- Codex high-privilege account, config-write, filesystem, command/process,
  plugin, import, and arbitrary MCP methods remain denied in the first release.
- The migration is a direct API cutover. The mobile client must switch to the
  common Agent routes in the same release that removes the Claude-specific
  routes.
- Existing persisted Claude task/session data is migrated to provider-aware
  metadata and remains usable through the Claude adapter. No old route is kept
  solely to read that data.

## Rollout

The parent task is delivered through two independently verifiable child tasks:

1. `07-20-agent-api-claude-migration` introduces the provider registry,
   descriptors, common capabilities, provider-aware task metadata, common
   routes, Claude adapter, mobile migration, and direct removal of the old
   Claude-specific routes. Native Claude behavior must pass before this child
   is complete.
2. `07-20-codex-app-server-adapter` depends on the first child. It adds the
   Codex bridge, native stream, catalog, turn controller, concurrent approvals,
   composer controls, reconnect, and live validation against the established
   provider contract.
3. Future providers implement the adapter contract and provider tests without
   duplicating common task/workspace/auth/reconnect code.

Rollback disables a provider registration and stops its runtime bridge without
touching provider-owned logs or other providers' tasks.
