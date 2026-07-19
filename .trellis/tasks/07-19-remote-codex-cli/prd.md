# Integrate remote Codex CLI control

## Goal

Introduce a provider-extensible Agent API in PocketPilot and use it to connect a
mobile client to the local Codex CLI. The client must be able to browse threads
in authorized workspaces, read history, resume an existing thread, create a new
thread, drive turns, receive streamed items, handle approvals, and interrupt
work while Codex remains authoritative for its own thread, turn, item, sandbox,
approval, and error semantics. The same outer API and adapter contract must be
usable by future OpenCode, Pi, and other local Agent integrations.

## Background

The official Codex App Server is the rich-client protocol. It uses bidirectional
JSON-RPC and exposes history, approvals, controls, and streamed item events. The
official TypeScript SDK is aimed at higher-level server automation and does not
provide the complete rich-client surface required here. The local environment
currently has `codex-cli 0.144.6`; protocol schemas can be generated with
`codex app-server generate-json-schema` and must be checked against the installed
CLI version.

PocketPilot already has device authentication, authorized directories, task
routing, control priorities, WebSocket transport, logging, and temporary event
replay for Claude. Claude `SDKUserMessage`, `SDKMessage`, `session_id`, Query
lifecycle, and single-approval assumptions are provider-specific and cannot be
used for Codex.

The current `TaskManager`, task `origin`, `sdkSessionId`, `/v1/sessions`, and
`/v1/tasks/{taskId}/sdk` contracts are Claude-specific. Adding Codex as another
set of conditionals would make later providers repeat storage, route, lifecycle,
and reconnect logic. A provider registry and stable Agent-facing API must own
those common concerns.

## Requirements

### R1. Provider-extensible Agent API

- Define a stable `AgentProviderAdapter` contract and provider registry. Claude,
  Codex, OpenCode, Pi, and future Agents are implementations of this contract,
  not branches embedded throughout `TaskManager` and route modules.
- `GET /v1/providers` returns every registered adapter, including unavailable
  providers, with one of `available`, `not_installed`, `disabled`, `unhealthy`,
  or `unsupported_version`, plus the detected protocol version and capability
  snapshot when available.
- Provider installation, enablement, disablement, and configuration are local
  administration operations. Remote clients can only read diagnostics-safe
  provider status and capabilities.
- The common layer owns provider discovery, capability reporting, authorized
  workspace validation, conversation discovery/create/attach, task lifecycle,
  operation idempotency, control priority, reconnect, and metadata-only audit.
- Provider-scoped conversation resources use
  `/v1/providers/{providerId}/conversations` and
  `/v1/providers/{providerId}/conversations/{conversationId}`. Attach is an
  explicit sub-resource action, and the provider-native task stream remains at
  `/v1/tasks/{taskId}/agent`.
- Every task and conversation reference includes a stable provider identifier.
  Provider-native IDs remain opaque values owned by the selected adapter.
- Capabilities are negotiated per provider rather than assumed globally. At a
  minimum they describe history pagination, new/resume support, active-turn
  steering, interrupt, models, effort, modes, approvals, attachments, and
  provider-native event protocol/version.
- The public API standardizes lifecycle, capability, authorization, control,
  and reconnect operations only. History rows, live messages, streamed events,
  and approval payloads remain provider-native and use provider-specific codecs.
- Migrate mobile clients directly to the common Agent API in one cutover. The
  existing Claude-specific routes are removed after migration and are not kept
  as compatibility facades. Existing persisted Claude data remains usable
  through `ClaudeProviderAdapter` after the provider-aware data migration.
- A task selects one provider for its entire lifetime. Its task metadata exposes
  the provider and native protocol version before the client opens the live
  stream, so native frames do not need a provider wrapper.
- A provider that lacks an optional capability returns an explicit unsupported
  result; the common layer must not emulate or silently downgrade native Agent
  behavior.
- Adding a future provider should require a new adapter, provider-specific
  codecs/tests, and registration, without adding provider conditionals to every
  common route or task lifecycle method.

### R2. Independent Codex provider boundary

- Use the official `codex app-server` local stdio JSONL transport. Do not expose
  the App Server WebSocket, which the official documentation marks
  experimental/unsupported, directly to mobile clients.
- PocketPilot owns authentication, workspace authorization, task/thread routing,
  control priority, reconnect, and audit. Codex JSON-RPC payloads remain native
  and are not wrapped as Claude or PocketPilot messages.
- Preserve existing Claude SDK-native payloads and behavior unchanged through
  the new task stream; only the public route contract is migrated.

### R3. Identity and lifecycle

- `taskId` is only the PocketPilot runtime-channel identifier. `threadId` is the
  Codex conversation, `turnId` is the current request, and `itemId` is a unit of
  work. They must remain distinct.
- Persist a Codex task only after `thread/start` returns a thread ID; do not
  simulate Claude's empty-task/null-session lifecycle.
- Support `thread/start`, `thread/resume`, `thread/read`, `thread/list`,
  `turn/start`, `turn/steer`, and `turn/interrupt`.

### R4. Thread discovery and history

- `thread/list` must explicitly include `sourceKinds: ["cli", "vscode", "appServer"]`
  and apply PocketPilot canonical workspace filtering to returned thread cwd
  values.
- Adapt cursor pagination and Codex thread/turn/item data rather than reusing
  Claude offset pagination, `beforeUuid`, or `SessionMessage` schemas.
- Prefer Codex experimental `thread/turns/list` and `thread/items/list` for long
  history when the installed server supports them. Otherwise use a bounded
  `thread/read(includeTurns=true)` fallback and report its capability/size limits.

### R5. Native streaming and approvals

- Transport allowed native `turn/*`, `item/*`, `item/agentMessage/delta`, command,
  file, permission, MCP, and `serverRequest/resolved` messages.
- Do not translate Codex events to Claude `stream_event` or fabricate token
  animation.
- Support multiple concurrent Codex server requests. The approval registry must
  key requests by JSON-RPC request ID and bind them to thread/turn/item; it must
  not reuse the current task-level single `pendingApproval` model.
- Retain Codex-native frames for bounded reconnect/replay with a PocketPilot
  cursor kept outside those frames. Replay unresolved server requests only
  while they remain valid.

### R6. Model, mode, sandbox, and workspace safety

- Read model and reasoning-effort choices from `model/list`; do not reuse the
  fixed Claude effort enum.
- Treat Codex `approvalPolicy`, `sandboxPolicy`, `permissions`, and optional
  `collaborationMode` as provider-specific controls rather than Claude
  `permission-mode` values.
- Revalidate every Codex thread/turn cwd and writable/readable root through the
  authorized-directory policy. Authorized directories are not a replacement
  for Codex sandbox enforcement.

### R7. Security boundary

- The first release exposes only the conversation-control allowlist. Mobile
  clients must not transparently call `account/*`, config writes, `fs/*`,
  `command/exec`, `process/*`, plugin installation, external-agent import, or
  arbitrary MCP tools.

### R8. Versioning and live validation

- The adapter records/validates the local Codex CLI version and generated schema.
  Unknown methods or security-sensitive fields fail closed.
- Live tests use a caller-provided workspace environment variable and never
  hardcode local paths, accounts, or credentials.

## Delivery plan

- `07-20-agent-api-claude-migration` establishes the provider contract,
  provider-aware persistence, common routes, Claude adapter, direct mobile/server
  cutover, and Claude regression baseline.
- `07-20-codex-app-server-adapter` depends on that child and then implements the
  complete Codex bridge, catalog, turn lifecycle, native stream, concurrent
  approvals, composer controls, reconnect, and live validation.
- The parent task is complete only after both children pass their independent
  acceptance and integration gates.

## Acceptance criteria

- [ ] Planning defines the App Server transport, stable/experimental capability
  boundary, and first-release RPC allowlist.
- [ ] A provider registry and `AgentProviderAdapter` contract isolate all
  provider-specific catalog, runtime, event, approval, and composer behavior.
- [ ] The public Agent API exposes provider discovery and per-provider
  capabilities, and future provider registration does not require duplicating
  common task/workspace/auth/reconnect routes.
- [ ] Provider discovery distinguishes installed, disabled, unhealthy, missing,
  and unsupported-version adapters without hiding unavailable providers.
- [ ] Design distinguishes `taskId`, `threadId`, `sessionId`, `turnId`, `itemId`,
  JSON-RPC request IDs, and the internal reconnect cursor.
- [ ] The first implementation lists CLI/VS Code/App Server threads in an
  authorized workspace, creates/resumes a thread, starts and steers a turn,
  receives agent deltas and final items, and interrupts correctly.
- [ ] A live test covers a new thread, streamed agent message, Codex approval or
  sandbox boundary, interrupt, and resume using a developer-provided workspace.
- [ ] Concurrent approvals, native turn/item status, and Codex errors are not
  collapsed into Claude's single approval or `TaskError` semantics.
- [ ] Existing Claude SDK tests and behavior remain unchanged.

## Out of scope

- Reusing Claude `SDKMessage`, `session_id`, `PermissionResult`, or SDK WebSocket
  inside the Codex adapter.
- PTY scraping, keyboard simulation, or terminal text parsing.
- Directly exposing Codex App Server to the LAN.
- Remote provider installation, enablement, disablement, or configuration.
- Mobile writes to Codex config, account login, filesystem APIs, or arbitrary MCP
  tools in the first release.
