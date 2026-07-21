# Implement: Polish mobile integration docs for parity

## Checklist

1. **Inventory freeze**
   - [ ] Re-read capability/error/route contracts and current OpenAPI notes.
   - [ ] List closed capability keys and confirm/error codes to include.
2. **Rewrite Codex mobile guide (EN)**
   - [ ] Replace `docs/codex-mobile-integration-guide.en.md` with client-path outline.
   - [ ] Cover readiness, capabilities, REST lifecycle, actions, catalogs, checkpoint reconnect, state machine, errors, differences, do/don’t.
3. **Mirror Codex mobile guide (zh-CN)**
   - [ ] Rewrite `docs/codex-mobile-integration-guide.zh-CN.md` to match EN section order/facts.
4. **Expand general mobile guide (EN)**
   - [ ] Restructure `docs/mobile-integration-guide.en.md` for multi-provider parity.
   - [ ] Full REST inventory including fork/archive/unarchive/delete.
   - [ ] Capability-driven client checklist + differences matrix.
5. **Mirror general mobile guide (zh-CN)**
   - [ ] Update `docs/mobile-integration-guide.zh-CN.md` equivalently.
6. **Light cross-links**
   - [ ] Touch `docs/codex-app-server-integration.en.md` only if pointers/section names need updating.
7. **Consistency pass**
   - [ ] en/zh H2 parity for both guide pairs.
   - [ ] No contradiction between general and Codex guides on checkpoint/confirm/historyFilters.
   - [ ] No invented APIs.
8. **Validation**
   - [ ] `pnpm test -- test/api-docs/mobile-openapi.test.ts`
   - [ ] Grep docs for stale claims: “every server frame is pure native” without checkpoint exception; missing fork/archive routes; disconnect always full rebuild only.

## Validation commands

```bash
pnpm test -- test/api-docs/mobile-openapi.test.ts
rg -n "fork|archive|unarchive|agent\\.checkpoint|historyFilters|CONFIRMATION_REQUIRED|HISTORY_FILTER_NOT_SUPPORTED" docs/mobile-integration-guide.en.md docs/mobile-integration-guide.zh-CN.md docs/codex-mobile-integration-guide.en.md docs/codex-mobile-integration-guide.zh-CN.md
```

## Risk / rollback

- Large markdown rewrites; keep changes docs-only.
- Rollback = revert the four guides (+ optional app-server touch).

## Out of implement scope

- Backend code
- Full app-server guide rewrite
- Claude SDK message-types rewrite
- Attachments / per-publish checkpoint product work
