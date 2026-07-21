# Design: Codex history options contracts

## Boundaries

- **Common layer**: capability type, registry sanitizer, OpenAPI schema, `TaskErrorCode`.
- **Claude adapter**: advertise `historyFilters.includeSystemMessages: true`; keep existing history behavior.
- **Codex adapter**: advertise `false`; gate `readConversation` on `includeSystemMessages === true`.
- **Routes**: no new endpoints; existing history query remains. Prefer adapter-level reject so fake-provider tests can mirror policy if needed; route continues to pass the boolean through.

## Contracts

### Capability

```ts
type AgentHistoryFilters = {
  includeSystemMessages: boolean;
};

type AgentCapabilitySnapshot = {
  // ...existing fields...
  historyFilters: AgentHistoryFilters;
};
```

Sanitizer (registry):

- Input missing / non-object → `{ includeSystemMessages: false }`
- `includeSystemMessages === true` → true; otherwise false
- Drop unknown keys

### History read

```ts
// CodexProviderAdapter.readConversation
if (input.includeSystemMessages === true) {
  throw new TaskError(
    "HISTORY_FILTER_NOT_SUPPORTED",
    409,
    "This provider does not support includeSystemMessages.",
  );
}
// else existing native thread/turns/list path
```

Claude continues to forward the flag to `readClaudeSessionHistory`.

### HTTP

Existing TaskError → JSON `{ code, message }` mapping. Status 409.

## Data flow

1. Client `GET .../capabilities` → closed `historyFilters`.
2. Client history request with optional query.
3. Runtime authorizes workspace, calls adapter `readConversation`.
4. Codex rejects `true` early; omit/`false` → native page.
5. Claude applies filter in session history reader.

## Compatibility

- Default history calls (no query) unchanged for both providers.
- Clients that already send `includeSystemMessages=false` to Codex keep working.
- Clients that send `true` to Codex start receiving 409 (intentional break of silent ignore).
- Capability field is additive; clients that ignore unknown fields still function.

## Trade-offs

- **Required closed object** (not optional) matches `threadManagement` style and avoids partial descriptors.
- Reject only `true` (not any presence of the key) so “default-off” clients stay green.
- Provider-neutral error code (not `CODEX_*`) so future non-Codex adapters can reuse it.

## Rollback

- Revert capability field + sanitizer + adapter gate + error code + docs/tests. No persistence/schema migration.

## Non-goals

- No Codex system-message projection layer.
- No Agent WebSocket history method changes.
- No replay checkpoint work.
