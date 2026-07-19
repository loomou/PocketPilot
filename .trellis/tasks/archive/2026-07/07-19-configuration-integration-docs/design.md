# Design: Local Admin integration documentation and flow audit

## Documentation boundary

Create two standalone documents under `docs/`:

- `docs/local-admin-integration-guide.en.md`
- `docs/local-admin-integration-guide.zh-CN.md`

Add links from the README near the existing integration documentation section. Both documents describe the same versioned repository behavior, with no mixed-language sections.

## Evidence model

Use implementation and tests as primary evidence in this order:

1. Route registration and schemas under `src/local-admin/` and `src/auth/local-admin-routes.ts`.
2. Services/coordinators that own directory authorization, pairing, devices, configuration persistence, and audits.
3. Browser API schemas and feature state transitions under `apps/local-admin/src/`.
4. Backend and frontend tests for edge cases and response reconciliation.
5. Trellis contracts only as supporting consistency references, not as a substitute for code.

## Document structure

Each language document will contain:

1. Scope and security boundary.
2. Startup/access prerequisites and CSRF contract.
3. Endpoint summary table.
4. Detailed workflows:
   - initial page load
   - runtime/task configuration save
   - directory browse/inspect/authorization
   - pairing QR generation and approval
   - device revocation
   - audit read
   - maintenance constraints
5. Data ownership and persistence semantics.
6. Error handling and concurrency/stale-snapshot behavior.
7. Frontend/backend alignment matrix with evidence and findings.
8. Recommended end-to-end integration checklist.

## Audit classification

Each frontend/backend comparison is classified as:

- Aligned: frontend follows the implemented backend contract.
- Partial: main call is correct but state reconciliation, validation, or UX differs.
- Mismatch: frontend calls an obsolete/unsupported flow or violates backend semantics.
- Not exposed: backend capability intentionally has no browser control.

Findings include severity, user impact, backend evidence, frontend evidence, and recommended action.

## Compatibility

No API or product code changes are planned. Documentation reflects the current branch at the time of audit and identifies any mismatches without silently documenting desired behavior as implemented behavior.
