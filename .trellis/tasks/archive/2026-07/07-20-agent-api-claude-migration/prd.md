# Agent API and Claude migration

## Goal

Introduce the provider-extensible PocketPilot Agent API and migrate the existing
Claude integration to it without changing Claude SDK-native behavior. Complete a
direct public API cutover so future providers can reuse common lifecycle,
authorization, and reconnect behavior without inheriting Claude schemas.

## Dependencies

- The parent task `07-19-remote-codex-cli` defines the cross-provider product
  contract and migration decisions.
- This task has no implementation dependency on the Codex adapter. It is the
  required predecessor of `07-20-codex-app-server-adapter`.

## Requirements

### Provider boundary

- Add an `AgentProviderAdapter` contract, provider registry, provider descriptor,
  and capability snapshot with no provider-specific imports in common modules.
- Discovery returns all registered providers with `available`, `not_installed`,
  `disabled`, `unhealthy`, or `unsupported_version` status.
- Provider installation, enablement, disablement, and configuration remain local
  administration operations. Remote clients receive read-only, diagnostics-safe
  status and capability data.
- A task is bound to one provider for its lifetime and exposes provider/native
  protocol metadata before its stream opens.

### Public API

- Expose `/v1/providers` and `/v1/providers/{providerId}/capabilities`.
- Expose provider-scoped conversation create/list/read/attach operations under
  `/v1/providers/{providerId}/conversations`.
- Expose the provider-native task stream at `/v1/tasks/{taskId}/agent` without
  wrapping frames in a synthetic common message envelope.
- Keep only lifecycle, authorization, capability, control, idempotency,
  reconnect, and audit semantics common. History rows, stream frames, approvals,
  and provider errors remain native.

### Persistence and Claude migration

- Add provider-aware task/runtime identity without repurposing Claude
  `sdkSessionId` or weakening existing Claude uniqueness constraints.
- Register Claude through `ClaudeProviderAdapter` and preserve raw
  `SDKUserMessage`, `SDKMessage`, partial streaming, Query lifecycle, approvals,
  replay, and error behavior.
- Migrate existing persisted Claude data to provider-aware metadata.
- Remove `/v1/sessions` and `/v1/tasks/{taskId}/sdk` from routes, OpenAPI, tests,
  and the mobile client in one cutover. Do not retain aliases or facades.

## Acceptance Criteria

- [ ] A fake provider can be registered and exercised through common routes
  without adding provider conditionals to common route or task modules.
- [ ] Provider discovery includes every availability state and exposes no local
  executable path, config path, credential, or raw process error.
- [ ] Provider-nested conversation routes and `/v1/tasks/{taskId}/agent` enforce
  device authentication and workspace authorization.
- [ ] Legacy Claude data remains usable through `ClaudeProviderAdapter` after an
  additive migration.
- [ ] Claude history, raw messages, partial deltas, approvals, reconnect, and
  controls behave identically through the new API.
- [ ] The old Claude-specific public routes and schemas are absent from runtime
  registration and generated API documentation.
- [ ] Lint, typecheck, unit/integration tests, build, and existing Claude live
  tests pass.

## Out of Scope

- Codex App Server process management or JSON-RPC implementation.
- OpenCode, Pi, or other concrete adapters.
- A universal normalized message, approval, history, or error schema.
- Remote provider installation or configuration.
