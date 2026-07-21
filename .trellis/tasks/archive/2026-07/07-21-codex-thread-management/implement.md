# Implement plan: Codex thread management

## Checklist

1. **Capability types + sanitizer**
   - Add closed `threadManagement` to `AgentProviderCapabilities`.
   - Update sanitizer, Claude empty object, provider-route Zod/OpenAPI, registry
     tests.

2. **Common provider surface**
   - Extend `AgentConversationListInput` with optional `searchTerm` / `archived`.
   - Add adapter methods (names can match design):
     - `forkConversation`
     - `archiveConversation`
     - `unarchiveConversation`
     - `deleteConversation`
   - Wire `AgentRuntimeManager` + provider routes.
   - Decide result schemas:
     - fork -> task operation result family
     - archive/unarchive/delete -> closed management result and/or task result
       when a task is affected

3. **Codex adapter**
   - Pass list filters into `thread/list`.
   - Implement fork/archive/unarchive/delete with:
     - authorized thread checks
     - threadId-only fork
     - confirm gate for archive/delete
     - fork task create/reuse
     - delete closes bound non-terminal task
     - path-safe response projection
   - Claude adapter: deny unsupported ops cleanly.

4. **Idempotency / actions**
   - Reuse `deviceId` + `operationId` operation execution path.
   - Extend action enum only if stored results remain task-metadata-safe.
   - Otherwise use a dedicated closed response schema for non-task-only ops.

5. **Tests**
   - Registry/capabilities/OpenAPI
   - Provider routes request validation
   - Codex adapter unit tests for filters, fork, archive/unarchive/delete,
     auth failures, confirm failures, bound-task close on delete, path omission

6. **Docs**
   - `docs/codex-mobile-integration-guide.en.md`
   - `docs/codex-mobile-integration-guide.zh-CN.md`
   - `docs/codex-app-server-integration.en.md`
   - Mention filters, REST lifecycle routes, confirm rules, task side effects,
     and exclusions (rollback, path fork, WS mutations)

7. **Contracts (Phase 3)**
   - Update:
     - `.trellis/spec/backend/agent-provider-contracts.md`
     - `.trellis/spec/backend/codex-app-server-contracts.md`
     - `.trellis/spec/backend/api-documentation-contracts.md` if needed

## Validation commands

```powershell
pnpm exec vitest run test/agent-providers/registry.test.ts test/remote-api/provider-routes.test.ts test/codex-app-server/provider-adapter.test.ts test/api-docs/mobile-openapi.test.ts
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

Optional later: non-destructive live list/filter only; destructive live ops need
cleanup design and are not a merge gate.

## Risky files / rollback points

| Area | Risk | Rollback / mitigation |
|---|---|---|
| Delete + task close ordering | Task closed even if native delete fails | Close only after native success |
| Fork path form | Host path fork from remote | Reject any non-threadId fork params |
| Result schema / action enum | Idempotency table polluted with native payloads | Store task metadata only; keep native rows out |
| Archive auto assumptions | Clients expect archive to end task | Document and test that archive does not auto-close |

## Review gates before `task.py start`

- [x] PRD decisions D1–D3 recorded
- [x] design covers REST contracts, task side effects, auth/projection
- [x] implement checklist + validation commands present
- [ ] `implement.jsonl` / `check.jsonl` curated with real entries
- [ ] User review approval to start implementation

## Follow-ups after implementation

- `trellis-check`
- Phase 3 contract update + commit + archive/journal
