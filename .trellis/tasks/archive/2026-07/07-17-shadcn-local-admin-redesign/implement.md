# Implementation plan: shadcn local-admin redesign

## Phase A — Pencil prototype and review

- [x] Inspect current local-admin functionality, API schemas, tests, and frontend Trellis contracts.
- [x] Define the recommended console information architecture and shadcn/new-york visual direction.
- [x] Confirm Pencil CLI is installed and authenticated.
- [x] Generate `prototype/local-admin-redesign.pen` with the required desktop, dialog, and interaction-state frames.
- [x] Export `prototype/local-admin-redesign-preview.png`.
- [x] Inspect the exported preview for completeness, clipping, overlap, and visual consistency.
- [x] Open the Pencil file or exported preview for user review.
- [x] Record user approval and remove mobile/narrow-screen scope from the prototype and planning artifacts.

## Phase B — Production implementation (blocked on prototype approval)

- [x] Run the PRD convergence pass and obtain explicit approval to implement.
- [x] Configure Trellis implementation/check context and activate the task.
- [x] Load `trellis-before-dev` and re-read all frontend contracts.
- [x] Add the minimum approved shadcn primitives under `apps/local-admin/src/components/ui`.
- [x] Decompose the administration feature without moving HTTP decoding out of `src/api/local-admin.ts`.
- [x] Implement the approved desktop-only application shell and views with Tailwind CSS.
- [x] Preserve all current operations, loading/error states, CSRF behavior, and local-only boundaries.
- [x] Update component tests for the approved observable structure and interactions.

## Validation

Pencil prototype checks:

```powershell
pencil status
Get-Item .trellis/tasks/07-17-shadcn-local-admin-redesign/prototype/local-admin-redesign.pen
Get-Item .trellis/tasks/07-17-shadcn-local-admin-redesign/prototype/local-admin-redesign-preview.png
git diff --name-only -- apps/local-admin
```

Production quality gate after Phase B:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:release:windows
```

## Risk and rollback points

- Do not start Phase B until the user accepts the Pencil direction.
- Avoid introducing a router or server-state library unless approved requirements demonstrate a need.
- Keep every production change behind existing local-admin endpoints; no database or API migration is expected.
- If decomposition causes behavioral drift, restore the existing `AdministrationPage` and reapply approved visual changes incrementally.
