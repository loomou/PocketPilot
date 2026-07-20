# Codex history options contracts

## Goal

Make the common conversation-history filter `includeSystemMessages` provider-honest: clients discover support via capabilities, and Codex rejects unsupported non-default filter values instead of silently ignoring them. Native Codex turn/item history rows stay unchanged.

## Background

- Common history route: `GET /v1/providers/{providerId}/conversations/{conversationId}` accepts optional `includeSystemMessages=true|false` (`src/remote-api/provider-routes.ts`).
- Claude honors the flag through `TaskManager.readClaudeSessionHistory` / SDK catalog (default `false` when omitted).
- Codex `CodexProviderAdapter.readConversation` loads native `thread/turns/list` and currently never reads `input.includeSystemMessages` (`src/codex-app-server/provider-adapter.ts`).
- Capabilities already use closed objects (`nativeActions`, `statusCatalogs`, `threadManagement`) plus `historyPagination`. There is no history-filter capability field today.
- Residual from archived parent audit `07-20-claude-code-parity-audit`: advertise support and/or reject unsupported filters; do not invent Claude-like system-message filtering for Codex.

## Requirements

1. **Closed historyFilters capability**
   - Add required `AgentCapabilitySnapshot.historyFilters: { includeSystemMessages: boolean }`.
   - Claude publishes `{ includeSystemMessages: true }`.
   - Codex publishes `{ includeSystemMessages: false }`.
   - Registry sanitizer admits only the reviewed key `includeSystemMessages` as a boolean; unknown keys and non-booleans drop/false; omit yields `{ includeSystemMessages: false }`.
2. **Codex reject non-default filter**
   - On `readConversation`, if `includeSystemMessages === true`, throw `TaskError("HISTORY_FILTER_NOT_SUPPORTED", 409, ...)` before any native history request.
   - Omit or `false` continue to return native turn/item history unchanged (no filtering/reshaping).
3. **Claude unchanged behavior**
   - Claude continues to honor `includeSystemMessages` for history inclusion; capability advertises `true`.
4. **Error catalog**
   - Add `HISTORY_FILTER_NOT_SUPPORTED` to `TaskErrorCode` and surface it through existing task-error HTTP mapping (409).
5. **API docs / mobile docs / contracts**
   - OpenAPI capability schema includes closed `historyFilters`.
   - Provider/Codex mobile guides state: Claude supports the filter; Codex does not; Codex `true` → 409; omit/`false` OK.
   - Update agent-provider (and related) backend contracts for capability + reject rules.

## Acceptance Criteria

- [ ] Capabilities for Claude include `historyFilters.includeSystemMessages: true`; Codex `false`.
- [ ] Registry sanitizer closes/drops unknown `historyFilters` keys and non-boolean values.
- [ ] Codex history with omit/`false` still returns native rows; `true` returns 409 `HISTORY_FILTER_NOT_SUPPORTED` without calling native list methods.
- [ ] Claude history with `true`/`false` still works as today.
- [ ] OpenAPI/tests cover the new capability field; adapter/route tests cover reject path.
- [ ] Docs and backend contracts describe the provider-honest policy.

## Out of Scope

- Filtering or reshaping Codex native turns/items into Claude system/user/assistant messages.
- New history filter keys beyond `includeSystemMessages`.
- Replay checkpoint / `afterCursor` (separate P3).
- Attachments and other deferred parity items.
- Changing list-conversation filters (`includeArchived` / `searchTerm`).

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Runtime policy | Advertise + reject only `includeSystemMessages=true` on unsupported providers |
| 2 | Capability shape | Closed `historyFilters: { includeSystemMessages: boolean }` |
| 3 | Error | `409 HISTORY_FILTER_NOT_SUPPORTED` |
| 4 | Docs | Capabilities + guides + OpenAPI + contracts (same pattern as prior capability tasks) |
