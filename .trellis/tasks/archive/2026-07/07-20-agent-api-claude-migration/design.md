# Agent API and Claude migration design

## Dependencies and boundary

This task implements the common contract defined by the parent task. It must be
completed and verified before `07-20-codex-app-server-adapter` begins. The Codex
child consumes this contract but must not drive Claude-specific compromises into
it.

## Architecture

```text
Remote API
  |-- ProviderRegistry
  |-- AgentRuntimeManager
  |-- provider-aware task repository
  `-- /v1/tasks/{taskId}/agent
          |
          `-- ClaudeProviderAdapter -> existing Claude SDK Query runtime
```

The registry owns descriptors, availability, and adapter lookup. The runtime
manager owns authentication, workspace authorization, task/provider binding,
control priority, idempotency, capacity, reconnect cursor management, and
metadata-only audit. The Claude adapter owns every Claude SDK type and behavior.

## Public contract

```text
GET  /v1/providers
GET  /v1/providers/{providerId}/capabilities
GET  /v1/providers/{providerId}/conversations?workspace=...
POST /v1/providers/{providerId}/conversations
GET  /v1/providers/{providerId}/conversations/{conversationId}
POST /v1/providers/{providerId}/conversations/{conversationId}/attach
GET  /v1/tasks/{taskId}/agent
```

Provider identity is a path boundary. Common HTTP envelopes contain stable task,
provider, protocol, pagination, and reconnect metadata only. Provider-native
history and live frames are not projected into a universal union.

## Persistence migration

Use an additive provider field and provider-owned runtime identity. Existing
Claude task/session rows default or migrate to `claude`, while Claude
`sdkSessionId` semantics and uniqueness remain intact. Provider selection is
immutable after task creation. Migration tests must cover legacy rows, duplicate
native identities, terminal tasks, and rollback to the prior application
version.

## Direct cutover

Server and mobile move in the same release. New routes become authoritative and
old `/v1/sessions` and `/v1/tasks/{taskId}/sdk` registrations are removed rather
than forwarded. Existing data remains readable through the Claude adapter, so
route compatibility is unnecessary.

## Security and operations

- Remote provider discovery is read-only.
- Local diagnostics are mapped to stable reason codes.
- Native streams are isolated by authenticated task and provider.
- Unsupported capabilities fail explicitly and are never emulated.
- Rollback deploys the previous application version; additive metadata is kept
  unless a separately reviewed down migration is necessary.
