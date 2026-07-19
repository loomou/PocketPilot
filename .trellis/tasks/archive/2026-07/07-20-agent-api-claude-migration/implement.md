# Agent API and Claude migration implementation plan

## Preconditions

- Keep this task in `planning` until its PRD and design are reviewed.
- Load all applicable backend Trellis specs with `trellis-before-dev` before
  changing source.
- Preserve the existing Claude SDK tests as the native-behavior baseline.

## Sequence

1. Define provider descriptors, capabilities, adapter lifecycle, native stream
   handles, and a registry with a fake-provider contract test.
2. Add provider-aware task/runtime persistence through an additive migration and
   legacy Claude migration tests.
3. Move current Claude catalog, Query runtime, controls, approval gate, and
   event journal behind `ClaudeProviderAdapter` without changing native types.
4. Add provider discovery, capability, provider-nested conversation, and common
   native task-stream routes.
5. Migrate the mobile client and remove the old Claude routes, schemas, OpenAPI
   entries, and route tests in the same cutover.
6. Update backend specs and operational/API documentation.
7. Run focused registry, migration, auth, workspace, task, replay, approval,
   OpenAPI, and Claude live tests before the full validation gate.

## Validation

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:claude:live
```

If the repository uses a different existing Claude live-test script, use that
authoritative script rather than introducing a duplicate command.

## Completion dependency

Do not start `07-20-codex-app-server-adapter` until the provider contract,
provider-aware persistence, native stream boundary, and Claude regression tests
from this task are complete.
