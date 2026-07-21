# Implement plan: Codex read-only status and catalogs

## Checklist

1. **Capability types + sanitizer**
   - Extend `AgentProviderCapabilities` with closed `statusCatalogs`.
   - Update `sanitizeProviderCapabilities`, Claude adapter, fake fixtures,
     provider-route Zod/OpenAPI schemas, and registry tests.

2. **Protocol allowlists and helpers**
   - Add the five methods to `codexClientRequestMethods` and
     `codexReadClientRequestMethods`.
   - Add D1 methods to `codexForwardedNotificationMethods`.
   - Add validators:
     - `account/read` rejects `refreshToken: true`
     - skills/hooks `cwds` normalization helpers
     - mcp list param bounds / thread binding helpers
   - Add pure projection helpers:
     - account readiness
     - skills/hooks/mcp list results
     - D1 notification params
   - Unit-test helpers in `test/codex-app-server/protocol.test.ts`.

3. **Adapter request path**
   - Keep routing through existing `submitRead`.
   - In `prepareTaskRequest` / dedicated validators:
     - force or authorize skills/hooks `cwds` to the task workspace
     - bind MCP `threadId` to the current task when provided/needed
     - reject unauthorized roots with `403 CODEX_REQUEST_NOT_ALLOWED`
   - Track pending remote request method metadata for projection.
   - Ensure interrupt/close/generation reset clears pending metadata.

4. **Adapter response + notification path**
   - Before `journal.publish` of task-owned responses, project results for the
     five methods.
   - Sanitize and forward only D1 notifications.
   - Fan out process-level D1 notifications to all non-terminal Codex runtimes.
   - Keep thread-bound hook notifications on matching `threadId` only.
   - Add adapter tests for rewrite, deny siblings, fan-out, cwd rejection, and
     P3 behavior.

5. **Docs**
   - Update:
     - `docs/codex-mobile-integration-guide.en.md`
     - `docs/codex-mobile-integration-guide.zh-CN.md`
     - `docs/codex-app-server-integration.en.md`
   - Document methods, projections, notifications, and explicit exclusions
     (login/write/MCP execution/path omission).

6. **Contracts (Phase 3, not implementation gate)**
   - After implementation/check, update:
     - `.trellis/spec/backend/agent-provider-contracts.md`
     - `.trellis/spec/backend/codex-app-server-contracts.md`
     - `.trellis/spec/backend/task-runtime-contracts.md` if P3 notes need
       refresh

## Validation commands

```powershell
pnpm exec vitest run test/agent-providers/registry.test.ts test/remote-api/provider-routes.test.ts test/codex-app-server/protocol.test.ts test/codex-app-server/provider-adapter.test.ts test/api-docs/mobile-openapi.test.ts
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

Optional later (not merge gate): non-mutating live reads only.

## Risky files / rollback points

| Area | Risk | Rollback |
|---|---|---|
| `provider-adapter.ts` response publish path | Accidentally publish unsanitized email/paths | Gate publish behind projection helpers; fail closed by omitting fields |
| Process-level notification fan-out | Spam or cross-task leakage | Fan out only D1 process-level methods; sanitize first |
| `cwds` defaulting | Native may query broader roots if omitted | Always inject authorized workspace root(s) |
| Capability schema | Open-ended catalogs reappear | Closed sanitizer + OpenAPI assertions |

## Review gates before `task.py start`

- [x] PRD decisions D1–D3 recorded
- [x] design covers request/response/notification/capability contracts
- [x] implement checklist + validation commands present
- [ ] `implement.jsonl` / `check.jsonl` curated with real spec/research entries
- [ ] User review approval to start implementation

## Follow-ups after implementation

- Run `trellis-check`
- Update backend contracts in Phase 3
- Commit, archive, journal via finish-work
