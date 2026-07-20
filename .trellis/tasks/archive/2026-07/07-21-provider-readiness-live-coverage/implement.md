# Implement plan: Provider readiness and live coverage

## Checklist

1. **Readiness model**
   - Add provider-neutral `refreshReadiness` (or equivalent) on adapters.
   - Add cache fields + single-flight probe promises.
   - Define stable reason codes and TTL constant.

2. **Codex probe**
   - Reuse `isCodexCommandAvailable`.
   - Add timeboxed initialize/version probe with clean child shutdown.
   - Map not_installed / unsupported_version / unhealthy / available.
   - Wire runtime construction to initial probe or lazy first discovery probe.

3. **Claude probe**
   - Cheap package/protocol readiness check.
   - Stop hardcoding unconditional `available` without a probe path.

4. **Discovery routes**
   - Refresh stale readiness before:
     - `GET /v1/providers`
     - `GET /v1/providers/{providerId}/capabilities`
   - Keep sanitized descriptors free of paths/secrets.

5. **Unit/integration tests**
   - Fake clocks/probes for status transitions, TTL, single-flight, route
     refresh, and unavailable execution.

6. **Live coverage**
   - Extend Codex live suite (or add provider-level live test file invoked by
     the same opt-in script) for D2 scenarios.
   - Ensure cleanup for forked threads.
   - Keep skip-without-env behavior.
   - Do not hardcode machine paths.

7. **Docs**
   - Update mobile/App Server docs for readiness semantics and live harness
     coverage.
   - Mention reason codes and that live mutations only clean disposable forks.

8. **Contracts (Phase 3)**
   - Update:
     - `.trellis/spec/backend/agent-provider-contracts.md`
     - `.trellis/spec/backend/codex-app-server-contracts.md` if probe details
       belong there
     - quality/api docs contracts if route behavior changes

## Validation commands

```powershell
pnpm exec vitest run test/agent-providers/registry.test.ts test/remote-api/provider-routes.test.ts test/codex-app-server/provider-adapter.test.ts test/agent-providers/claude-provider-adapter.test.ts
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

Optional live (caller-provided workspace only):

```powershell
pnpm test:codex:live
```

## Risky files / rollback points

| Area | Risk | Mitigation |
|---|---|---|
| Codex initialize probe | orphan processes / port/file locks | always close probe child in `finally`; single-flight |
| Discovery latency | slow `/providers` | TTL + cache + short timeout |
| Live fork/delete | accidental user-thread mutation | only mutate threads created by the test |
| Descriptor leakage | path/version dump | sanitize reason codes only |

## Review gates before `task.py start`

- [x] PRD decisions D1–D2 recorded
- [x] design covers readiness mapping, cache, live scenarios
- [x] implement checklist + validation commands present
- [ ] `implement.jsonl` / `check.jsonl` curated with real entries
- [ ] User review approval to start implementation

## Follow-ups after implementation

- `trellis-check`
- Phase 3 contracts + commit + archive/journal
