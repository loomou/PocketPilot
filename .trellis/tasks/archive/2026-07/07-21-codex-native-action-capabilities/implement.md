# Implementation plan: Codex native action capabilities

## Ordered checklist

1. Extend provider capability types, sanitizer, Zod/OpenAPI schemas, Claude and
   fake-provider fixtures with the closed `nativeActions` shape. Set Codex
   `attachments` to `false` and publish the three reviewed descriptors.
2. Add strict action parameter validation and allowlist the native
   `review/start`, `thread/name/set`, and `thread/compact/start` methods.
   Reject detached review and unsupported targets before forwarding.
3. Refactor the Codex adapter's pending turn-start bookkeeping so normal turns,
   inline reviews, and compaction share idle checks, capacity reservation,
   journal retention, ownership, native response rollback, and authoritative
   notification handling.
4. Track runtime-only active turn kind and reject steering for review/compact
   while preserving interrupt behavior. Route rename through P2 without idle or
   capacity requirements.
5. Add protocol and adapter tests for native passthrough, current-thread
   binding, action validation, idle/active gating, non-steerable turns, shared
   capacity, P0/P1 invalidation, workspace revocation, and both forwarding and
   native-response rollback paths.
6. Add registry, provider route, and OpenAPI assertions for exact sanitized
   capability output, including `attachments: false` and `nativeActions`.
7. Update `docs/codex-mobile-integration-guide.en.md`,
   `docs/codex-mobile-integration-guide.zh-CN.md`, and
   `docs/codex-app-server-integration.en.md` with capability discovery and
   native action examples.
8. Run focused tests, full static checks, and the ordinary test suite. Inspect
   the final diff for native-protocol wrappers, unreviewed methods, accidental
   path/credential exposure, or unrelated changes.
9. In Phase 3, update `.trellis/spec/backend/agent-provider-contracts.md`,
   `.trellis/spec/backend/codex-app-server-contracts.md`, and
   `.trellis/spec/backend/task-runtime-contracts.md` with the verified contract.

## Validation commands

```powershell
pnpm exec vitest run test/agent-providers/registry.test.ts test/remote-api/provider-routes.test.ts test/codex-app-server/protocol.test.ts test/codex-app-server/provider-adapter.test.ts
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

Run any existing OpenAPI snapshot/contract test discovered during
implementation in the focused set. The optional live suite remains
caller-configured and must not hardcode a workspace:

```powershell
$env:CODEX_APP_SERVER_TEST_CWD = "<absolute-workspace-path>"
pnpm test:codex:live
```

The live suite is not a planning gate and should run only when the caller
provides a safe disposable workspace. If the existing live harness does not
yet cover native actions, do not add destructive rename/compact/review behavior
to it without an explicit cleanup design.

## Risky files and rollback points

- `src/agent-providers/types.ts`, `src/agent-providers/registry.ts`, and
  `src/remote-api/provider-routes.ts`: a capability mismatch can make OpenAPI
  reject every provider response. Update all producers, fixtures, and schemas
  together.
- `src/codex-app-server/provider-adapter.ts`: premature deletion of a pending
  start can lose review/compact kind; overly broad rollback can release a turn
  after authoritative `turn/started`. Keep focused ordering tests around both
  response-before-notification and notification-before-response cases.
- `src/codex-app-server/protocol.ts`: the allowlist is a security boundary.
  Add only the three reviewed methods.
- Documentation examples must match the generated OpenAPI capability shape and
  installed native schema. Do not copy local generated schema paths into docs.

## Review gates before activation

- PRD, design, and implementation plan contain no unresolved product question.
- Capability metadata is descriptive only; execution stays native WebSocket.
- Review is inline-only and attachment delivery remains deferred.
- Review and compact share turn lifecycle; rename does not.
- The user explicitly approves `task.py start` after reviewing these artifacts.

