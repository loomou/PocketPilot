# Codex App Server vs. PocketPilot's Claude SDK integration

## Executive summary

PocketPilot's current Claude integration gives each task a long-lived Claude SDK
Query and transports the SDK's native messages over an authenticated WebSocket.
Codex App Server is not an equivalent SDK message stream. It is a bidirectional
JSON-RPC protocol for rich clients, with this native object hierarchy:

```text
PocketPilot taskId
  -> Codex threadId (persistent conversation branch)
       -> Codex turnId (one user request and its execution)
            -> Codex item (message, command, file change, tool call, and more)
```

PocketPilot can reuse device authentication, authorized-workspace policy, task
routing, control priorities, logging, and reconnect infrastructure. It cannot
reuse Claude's `SDKUserMessage`, `SDKMessage`, `session_id`, single-approval
state, UUID replay rules, or model and permission enums.

This research uses:

- Official App Server documentation:
  <https://developers.openai.com/codex/app-server.md>
- Official Codex SDK documentation:
  <https://developers.openai.com/codex/codex-sdk.md>
- The locally installed `codex-cli 0.144.6`, including
  `codex app-server --help` and schemas generated with
  `codex app-server generate-json-schema --experimental`.

## Current Claude capability baseline

Repository evidence:

- `src/claude-sdk/session.ts:64-185`: one long-lived Query; native
  `SDKUserMessage` input and native `SDKMessage` output;
  `includePartialMessages: true`; model, permission, effort, and interrupt
  controls.
- `src/claude-sdk/session-catalog.ts`: session discovery and history through
  `listSessions`, `getSessionInfo`, and `getSessionMessages`.
- `src/remote-api/task-sdk-routes.ts:91`: bidirectional
  `/v1/tasks/{taskId}/sdk` WebSocket that accepts only Claude
  `SDKUserMessage` and sends only Claude `SDKMessage`.
- `src/remote-api/session-routes.ts:116-220`: session list, history, new
  conversation, and existing-session attachment APIs.
- `src/remote-api/task-routes.ts:117-399`: task, interrupt, close, resume,
  model, permission mode, effort, and approval APIs.
- `src/tasks/task-event-journal.ts:77-180`: separate control and SDK channels,
  with active-turn replay keyed by SDK message UUID.
- `src/tasks/task-manager.ts:514-1220`: Claude catalog/history, long-lived
  Query, input, interrupt, resume, approval, and composer controls.

Important Claude semantics:

1. PocketPilot can create an empty task before Claude has allocated a session.
   The new `session_id` becomes known only after the Query emits a message.
2. Continuing an existing Claude session uses `Options.resume=sessionId` and
   never copies historical messages into a new prompt.
3. SDK input can carry `priority` and `shouldQuery`. PocketPilot observes those
   values only for capacity and lifecycle accounting and does not reinterpret
   SDK scheduling.
4. The current task runtime retains at most one active `CanUseTool` approval,
   whose response is a complete Claude `PermissionResult`.

## Native Codex App Server capabilities

### Connection and protocol

| Concern | Codex App Server |
| --- | --- |
| Protocol | Bidirectional JSON-RPC 2.0, with the `jsonrpc: "2.0"` field omitted on the wire |
| Default transport | `stdio://` using newline-delimited JSONL |
| Other local transport | Unix socket |
| WebSocket | Available but officially experimental and unsupported; non-loopback exposure also requires separate authentication and TLS |
| Initialization | Each connection must send `initialize`, then `initialized`, before any other method |
| Versioning | Protocol schemas match the installed CLI and can be generated with `generate-ts` or `generate-json-schema` |

Unlike the Claude Query interface, one App Server connection carries requests,
responses, notifications, and server-initiated requests. PocketPilot must track
both ordinary JSON-RPC request IDs and pending server-request IDs.

### Threads, turns, and items

The core App Server methods include:

- `thread/start`: creates a new thread and immediately returns `thread.id`; the
  response can also include `thread.sessionId`. Root threads use their own ID as
  the session-tree root, while forks retain the root session ID.
- `thread/resume`: loads an existing thread by ID so later `turn/start` calls
  append to it.
- `thread/fork`: copies history into a new thread ID. This is not equivalent to
  Claude resume.
- `thread/read`: reads a stored thread without loading or subscribing to it;
  `includeTurns=true` returns its turns.
- `thread/list`: cursor-paginates stored threads and supports `cwd`, `archived`,
  `searchTerm`, `modelProviders`, and `sourceKinds` filters.
- `turn/start`: begins one turn on a thread.
- `turn/steer`: appends input to the current active turn and requires a matching
  `expectedTurnId`; it cannot carry model, cwd, or sandbox overrides.
- `turn/interrupt`: interrupts a specific `threadId + turnId`; the final turn
  status becomes `interrupted`.

A turn streams through `turn/started`, `item/started`, item-specific deltas,
`item/completed`, and `turn/completed`. Common items include `userMessage`,
`agentMessage`, `reasoning`, `plan`, `commandExecution`, `fileChange`, and
`mcpToolCall`.

## Capability difference matrix

| Capability | Current Claude integration | Codex App Server | Required PocketPilot treatment |
| --- | --- | --- | --- |
| Remote wire protocol | Native `SDKUserMessage` / `SDKMessage` WebSocket | JSON-RPC requests, responses, notifications, and server requests | **Do not share message schemas.** Add a Codex adapter. Keep provider payloads native and keep taskId in routing and internal metadata only. |
| New conversation ID | An empty task can exist before the first emitted `session_id` | `thread/start` immediately returns thread and session-tree identifiers | **Different lifecycle.** Bind a Codex task after `thread/start` succeeds; do not simulate Claude's null-session state. |
| Conversation identity | `taskId` and `sdkSessionId` are separate; one task owns one Query | `taskId`, `threadId`, `sessionId`, `turnId`, and `itemId` have separate meanings; a fork can have different thread and session IDs | **Add Codex metadata.** Store at least threadId, sessionId, and activeTurnId. Never substitute taskId for threadId. |
| History discovery | SDK `listSessions`, offset pagination, and PocketPilot workspace filtering | `thread/list` cursor pagination; the default sources are only `cli` and `vscode`; App Server-created threads require explicit `appServer`; cwd filtering is exact | **Adapt discovery.** Request `sourceKinds: ["cli", "vscode", "appServer"]`, then enforce PocketPilot canonical path filtering. Do not reuse offset pagination. |
| History loading | `getSessionMessages` returns SDK `SessionMessage[]`; PocketPilot exposes up to 50 rows before a UUID cursor | Stable `thread/read(includeTurns=true)` loads full turns; paginated `thread/turns/list` and `thread/items/list` are currently experimental | **Do not assume stable pagination.** Detect capability, prefer supported pagination, and use a size-limited full-read fallback. |
| History row model | Claude-owned `SessionMessage` | Codex `Thread`, `Turn`, and `ThreadItem` | **Use a provider-specific reducer.** Only the loading and virtualization UX can be shared. |
| User input | Native `SDKUserMessage` with optional `priority` and `shouldQuery` | `turn/start.input` accepts Codex `UserInput[]`, including text, image, local image, skill, and mention | **Adapt payload construction.** The composer UI may be shared, but input objects remain Codex-owned. |
| Input during active work | The same SDK input stream accepts later messages and preserves SDK scheduling fields | Active work is changed with `turn/steer(expectedTurnId)`; no equivalent `now/next/later` field exists | **Do not map Claude priority.** Expose native start-versus-steer behavior and let App Server enforce the active-turn precondition. |
| Streaming text | Claude `stream_event` deltas followed by authoritative `assistant`/`result` messages | `item/agentMessage/delta` followed by authoritative `item/completed(agentMessage)` and turn completion | **Share only the streaming UI concept.** Use a separate Codex item reducer keyed by native item IDs. |
| Tool and file events | Open SDK variants for tool use and progress | Explicit `commandExecution`, `fileChange`, and `mcpToolCall` items plus command output and `turn/diff/updated` | **Add a Codex item reducer.** The legacy `fileChange/outputDelta` is deprecated; use fileChange items and turn diffs. |
| Pending approvals | The current task holds one pending `CanUseTool` request | Multiple method-specific JSON-RPC server requests can be pending concurrently, including command, file, permissions, MCP elicitation, and user input | **Do not reuse the single pending approval.** Add `Map<requestId, PendingCodexRequest>` and preserve each native response schema. |
| Command approval | Claude `PermissionResult` allow/deny with optional updated input/permissions | `accept`, `acceptForSession`, `decline`, `cancel`, or exec/network policy amendments | **Provider-specific response.** Never coerce Codex decisions into Claude allow/deny. |
| File approval | Routed through the generic Claude tool-permission callback | Dedicated `item/fileChange/requestApproval` with session-level accept support | **Add a distinct approval type.** It is not identified by Claude toolName. |
| Interaction mode | Claude permission modes combine values such as `default`, `acceptEdits`, and `plan` | `approvalPolicy`, `sandbox`/`sandboxPolicy`, and experimental `collaborationMode` are separate; the installed schema currently exposes `plan` and `default` modes | **No one-to-one mapping.** The UI location can be shared, but values and schemas are Codex-specific. |
| Models | Query `supportedModels()` returns Claude `ModelInfo[]`; a live setter changes the next turn | `model/list` returns model, supported reasoning effort, modalities, and defaults; thread/turn overrides become sticky for later turns | **Share the picker interaction, not the type.** Use the installed App Server catalog. |
| Reasoning effort | `applyFlagSettings({ effortLevel })` uses a fixed Claude enum | `effort` is a model-advertised non-empty string and can vary by installed model catalog | **Do not reuse the fixed enum.** Build choices from each Codex model's `supportedReasoningEfforts`. |
| Working directory | Query cwd is fixed at creation and authorized once | Thread and turn methods can override cwd; sandbox policy can also declare read/write roots | **Validate every entry point.** Canonicalize each cwd/root against PocketPilot policy. Authorization is not a replacement for Codex sandboxing. |
| Sandbox and permissions | Claude SDK permission mode with PocketPilot forwarding live controls | Codex has `dangerFullAccess`, `readOnly`, `workspaceWrite`, `externalSandbox`, and optional named permission profiles | **Use provider-specific state.** Do not store this in Claude's permissionMode field. |
| Interrupt | Query-level `interrupt()` returns the task to idle while retaining the Query | `turn/interrupt(threadId, turnId)` completes a specific turn as interrupted | **Reuse outer priority, not the call shape.** Do not interrupt without an authoritative activeTurnId. |
| Close, archive, delete | PocketPilot close terminalizes the runtime and closes Query; the Claude session can still be selected later | `thread/unsubscribe` detaches, `thread/archive` archives, `thread/delete` permanently deletes, and an unsubscribed thread can unload automatically | **Do not map close to archive/delete.** Runtime close should unsubscribe/detach; archive and delete require explicit user actions. |
| Reconnect replay | `/sdk?afterUuid=` replays the retained active turn by SDK message UUID | App Server notifications have no universal replay cursor and subscriptions are connection-local | **Reuse journal storage, not UUID semantics.** Use an internal sequence outside provider frames and retain unresolved server requests explicitly. |
| Runtime status | PocketPilot stores `idle`, `executing`, `awaiting_approval`, `interrupted`, and `terminal` | Thread status includes `notLoaded`, `idle`, `active`, and `systemError`; turns include `inProgress`, `completed`, `interrupted`, and `failed` | **Keep both layers.** PocketPilot state is for routing/capacity; native Codex status remains authoritative and unmodified. |
| Errors | PocketPilot maps failures to task-domain errors and stable WebSocket close codes | JSON-RPC errors and failed turns carry native `codexErrorInfo` categories | **Preserve Codex errors.** Add separate safe transport failures rather than translating everything to Claude `TaskError`. |
| Configuration and authentication | PocketPilot local configuration/device auth; Claude uses the local environment | App Server also exposes high-privilege `account/*`, `config/*`, `fs/*`, MCP, App, skills, and process RPCs | **Allowlist the conversation subset.** Do not transparently expose account, config writes, filesystem, or command execution to mobile clients. |
| Slash commands and review | Claude commands depend on Claude Code/SDK behavior | App Server exposes explicit methods such as `review/start` but no generic RPC for every CLI slash command | **Do not copy the Claude command list.** Each Codex command needs an official RPC or verified plain-text behavior. |

## Reuse boundaries

### Implication for future providers

The Claude/Codex comparison shows that PocketPilot should not make Codex the
second hardcoded runtime inside the existing Claude-oriented `TaskManager`.
OpenCode, Pi, and other future Agents may introduce different conversation IDs,
turn semantics, stream events, controls, and approvals. The reusable boundary
must therefore be a provider registry and an orchestration-focused adapter
contract.

The common API should standardize provider discovery, capabilities, authorized
workspaces, conversation/task lifecycle, control priority, reconnect, and audit.
History rows, native messages, streamed events, approval payloads, and errors
must remain provider-owned. A task exposes its provider and native protocol
version before the stream opens, allowing the client to select the correct codec
without wrapping every provider frame.

### Directly reusable

- Device pairing, bearer authentication, and revocation.
- Authorized-directory settings and canonical path policy, with repeated checks
  at every Codex cwd/root parameter boundary.
- PocketPilot `taskId` routing, P0/P1/P2 control priority, capacity limits,
  preemptive close, and interrupt framework.
- Local logging, health checks, startup output, metadata-only audit, and safe
  error handling.
- The architectural rule that provider traffic and PocketPilot control events
  remain separate.
- WebSocket registries and the memory/encrypted-overflow replay storage pattern,
  after replacing Claude-specific cursors and pending state.

### New Codex adapters required

- `CodexAppServerBridge`: starts `codex app-server --listen stdio://`, performs
  the handshake, and manages JSON-RPC IDs and process lifecycle.
- `CodexThreadCatalog`: wraps `thread/list`, `thread/read`, `thread/start`, and
  `thread/resume`, including App Server sources and authorized-cwd filtering.
- `CodexTurnController`: wraps `turn/start`, `turn/steer`, and
  `turn/interrupt`, preserving native turn status.
- A Codex item/event journal using internal sequence cursors and native frames.
- A multi-request approval registry for command, file, permissions, MCP
  elicitation, and user-input server requests.
- Codex-specific model, mode, sandbox, and reasoning-effort catalogs.

### Existing interfaces that must not be reused

- The Claude frame parser and `/sdk` endpoint in
  `src/remote-api/task-sdk-routes.ts`.
- `sdkUserMessageTransportSchema`, `SDKMessage`, `SessionMessage`,
  `PermissionResult`, and the `sdkSessionId` field.
- `TaskEventJournal.subscribeSdk(afterUuid)` and its UUID replay assumption.
- The current `TaskManager` model of one Query, one Claude session, and one
  pending approval.
- Claude permission-mode, effort enums, and composer response schemas.

## Recommended first-release boundary

### Bridge and connection topology

1. PocketPilot starts a local stdio App Server bridge and never exposes the App
   Server WebSocket directly to the LAN.
2. The bridge performs `initialize`/`initialized`; mobile clients do not
   impersonate an App Server transport connection.
3. A separate task-scoped Codex WebSocket carries the allowlisted native App
   Server JSON-RPC subset. PocketPilot authenticates, routes, validates paths,
   replays, and audits without wrapping provider messages in
   `{ kind: "codex" }`.
4. PocketPilot retains the mapping
   `taskId -> threadId -> activeTurnId`. Native thread, turn, item, and request
   IDs remain unchanged in provider payloads.

### Initial RPC allowlist

Stable core:

- Threads: `thread/start`, `thread/list`, `thread/read`, `thread/resume`.
- Turns: `turn/start`, `turn/steer`, `turn/interrupt`.
- Catalog: `model/list`.
- Internal connection management: `thread/unsubscribe`.
- Events: relevant `thread/*`, `turn/*`, `item/*`,
  `serverRequest/resolved`, `error`, `warning`, and `configWarning` messages.
- Approval responses: method-specific responses for a request proven to belong
  to the current task, thread, turn, and device.

Capability-gated after schema and experimental initialization checks:

- `thread/turns/list` and `thread/items/list` for paginated history.
- `collaborationMode/list`, `review/start`, `tool/requestUserInput`, and
  permission profiles.

Denied from mobile clients in the first release:

- `account/*`, `config/*write`, `fs/*`, `command/exec`, `process/*`, plugin
  installation, external-agent import, and arbitrary MCP tool calls.

### Long-history strategy

Stable `thread/read(includeTurns=true)` can return the complete history. The
experimental turn/item pagination methods are the closest equivalent to the
current Claude newest-page and upward-loading behavior. The adapter should:

1. Record the App Server CLI version and generated schema capabilities.
2. Prefer experimental pagination only when the installed server advertises it.
3. Fall back to `thread/read` with explicit response and memory limits rather
   than silently loading an unbounded thread into a normal list.

## Implementation risks to resolve

1. App Server schemas change with the installed CLI version. A single handwritten
   static TypeScript union is insufficient.
2. `thread/list.cwd` is exact-match while PocketPilot workspace authorization is
   descendant-based. Result filtering or multi-directory queries are required.
3. App Server can have multiple pending server requests; the current single
   task approval and approval UI are insufficient.
4. A live test must determine what survives a mobile disconnect and what happens
   to an active turn when the PocketPilot bridge process restarts. `thread/resume`
   must not be assumed to resume in-flight work.
5. `thread/start` allocates an ID earlier than Claude allocates a session ID.
   Empty-thread cleanup must use native Codex archive/delete semantics rather
   than Claude's empty-task assumptions.

## Final finding

The primary difference is not naming. Claude is a long-lived Query with a
native SDK message stream; Codex is a thread/turn/item state machine over
bidirectional JSON-RPC. The correct integration shares PocketPilot's outer
security and runtime channel but adds an independent Codex provider adapter,
native event reducer, and multi-request registry. Mobile clients may share
workspace, connection, loading, and streaming UX, but not Claude payloads or
state enums.
