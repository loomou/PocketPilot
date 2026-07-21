# Implement: Codex replay checkpoint

## Checklist

1. **Journal / adapter emission**
   - [ ] Emit `agent.checkpoint` once at start of Codex subscribe, before retained replay.
   - [ ] Prefer `CodexNativeJournal.subscribe` so all Codex subscribers share ordering.
   - [ ] `payload.cursor = latestCursor(taskId)` or `null`.
   - [ ] `payload.provider = "codex"`.
2. **Keep native frames pure**
   - [ ] No cursor fields on retained/live native objects.
3. **Claude**
   - [ ] Do not emit checkpoint on Claude Agent subscribe.
4. **Tests**
   - [ ] `test/codex-app-server/journal.test.ts`: first message is checkpoint; then retained frames; null cursor when empty; native frames unchanged.
   - [ ] Adapter/route coverage if subscribe is wrapped at adapter level.
   - [ ] Optional: Claude adapter test asserts no `agent.checkpoint`.
5. **Docs**
   - [ ] `docs/codex-mobile-integration-guide.en.md` + `.zh-CN.md` § reconnect: first-frame checkpoint; optional afterCursor; skip non-native frames.
   - [ ] `docs/codex-app-server-integration.en.md` if it documents Agent stream purity.
   - [ ] `src/remote-api/task-agent-routes.ts` documentation strings if they claim zero PocketPilot wrappers (Codex exception).
6. **Contracts (Phase 3)**
   - [ ] `.trellis/spec/backend/codex-app-server-contracts.md` — checkpoint frame + ordering.
   - [ ] `.trellis/spec/backend/agent-provider-contracts.md` if taskStream subscribe contract is specified.
   - [ ] `.trellis/spec/backend/api-documentation-contracts.md` if needed.

## Validation

```bash
pnpm test -- test/codex-app-server/journal.test.ts test/codex-app-server/provider-adapter.test.ts test/remote-api/task-agent-routes.test.ts test/agent-providers/claude-provider-adapter.test.ts
pnpm typecheck
```

## Risk / rollback

- Protocol extension may break naive native-only parsers → docs + skip rule required.
- Rollback: remove emit; journal behavior remains.

## Out of implement scope

- Per-publish checkpoints
- Claude checkpoints
- REST/control-events primary channel
