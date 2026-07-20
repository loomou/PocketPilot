# Implement: Codex history options contracts

## Checklist

1. **Types**
   - [ ] `src/agent-providers/types.ts`: add `AgentHistoryFilters` and required `historyFilters` on `AgentCapabilitySnapshot`.
2. **Error catalog**
   - [ ] `src/tasks/errors.ts`: add `HISTORY_FILTER_NOT_SUPPORTED`.
3. **Registry sanitizer**
   - [ ] `src/agent-providers/registry.ts`: sanitize closed `historyFilters` (boolean key only).
4. **Claude adapter**
   - [ ] Publish `historyFilters: { includeSystemMessages: true }` in capability snapshot.
5. **Codex adapter**
   - [ ] Publish `historyFilters: { includeSystemMessages: false }`.
   - [ ] `readConversation`: reject `includeSystemMessages === true` with 409 before native calls.
6. **OpenAPI / routes schema**
   - [ ] `src/remote-api/provider-routes.ts` capability schema: required closed `historyFilters`.
   - [ ] Ensure generated/mobile OpenAPI tests still pass (`src/api-docs/mobile-openapi.ts` if regenerated via routes).
7. **Tests**
   - [ ] `test/agent-providers/registry.test.ts`: sanitizer + projection for `historyFilters`.
   - [ ] `test/codex-app-server/provider-adapter.test.ts`: reject `true`; allow omit/`false`; capability false.
   - [ ] Claude adapter/route tests: capability true; history still honors flag (existing coverage or small add).
   - [ ] `test/remote-api/provider-routes.test.ts` / OpenAPI: schema includes `historyFilters`.
   - [ ] Update any fake provider capability fixtures that construct full snapshots.
8. **Docs**
   - [ ] `docs/codex-mobile-integration-guide.en.md` + `.zh-CN.md`
   - [ ] `docs/mobile-integration-guide.en.md` (and Claude guide if it documents history filters)
   - [ ] Note: Claude supports filter; Codex advertises false and rejects true.
9. **Contracts (Phase 3)**
   - [ ] `.trellis/spec/backend/agent-provider-contracts.md`
   - [ ] Codex/error contracts if they list TaskError codes or history rules

## Validation

```bash
pnpm test -- test/agent-providers/registry.test.ts test/codex-app-server/provider-adapter.test.ts test/agent-providers/claude-provider-adapter.test.ts test/remote-api/provider-routes.test.ts test/api-docs/mobile-openapi.test.ts
```

Broader if fixtures break:

```bash
pnpm test
```

## Risk / rollback points

- High-touch: every full capability fixture (tests + adapters) must add `historyFilters`.
- Rollback: revert the same files; no DB migration.

## Out of implement scope

- Replay checkpoint
- Additional history filter keys
- Codex message-shape translation
