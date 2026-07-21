# Implement: Fix Codex originator 403

## Scope

Lightweight task. No separate design.md: single handshake field change plus tests/docs.

## Checklist

1. Change `src/codex-app-server/bridge.ts` initialize payload:
   - `clientInfo.name`: `"pocketpilot"` → `"codex_cli_rs"`
   - keep `clientInfo.title`: `"PocketPilot"`
   - keep `clientInfo.version` as-is
2. Update/add unit assertion in `test/codex-app-server/bridge.test.ts`:
   - after `bridge.start()`, inspect the initialize write
   - expect `params.clientInfo.name === "codex_cli_rs"`
   - expect `params.clientInfo.title === "PocketPilot"`
3. Update `.trellis/spec/backend/codex-app-server-contracts.md` Native bridge section:
   - document that App Server client originator uses `clientInfo.name = codex_cli_rs`
   - note this is independent of `config.toml` / CODEX_HOME auth config
4. Run unit tests:
   - `pnpm exec vitest run test/codex-app-server/bridge.test.ts`
5. Live validation (auth-gated):
   - `pnpm exec node scripts/run-codex-app-server-live-tests.mjs`
   - pass criterion: no `originator not in endpoint whitelist (originator=pocketpilot)`
   - if ChatGPT auth missing, record skip; do not claim AC4 green

## Validation commands

```bash
pnpm exec vitest run test/codex-app-server/bridge.test.ts
pnpm exec node scripts/run-codex-app-server-live-tests.mjs
```

## Rollback

Revert `clientInfo.name` to `"pocketpilot"` and drop the new assertion/doc lines.

## Non-goals during implementation

- Do not add `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` unless live still 403 after name change
- Do not change request-id prefix `pocketpilot:...`
- Do not expand into live-test-parity scenario work
