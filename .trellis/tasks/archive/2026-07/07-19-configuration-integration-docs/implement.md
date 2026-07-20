# Implementation Plan

1. Load backend/frontend Trellis specs relevant to local administration, HTTP routes, configuration state, security, and documentation quality.
2. Inventory every route mounted on the localhost administration server and trace each handler into its service/storage owner.
3. Read backend tests for success, validation, error, stale revision, pairing, revocation, and security boundary behavior.
4. Inventory the Local Admin browser API calls, page state transitions, and section components; trace each UI action to its HTTP request and reconciliation behavior.
5. Build a source-backed endpoint and workflow matrix, recording aligned, partial, mismatch, and intentionally terminal-only behavior.
6. Write the English integration guide under `docs/`.
7. Write the Simplified Chinese guide with equivalent structure and semantics.
8. Add README links to both guides.
9. Cross-check all paths, methods, fields, status effects, and findings against code/tests; run Markdown/project quality checks.
10. Update acceptance criteria, perform Trellis quality/spec review, commit, archive, journal, and push.

## Validation Commands

- `rg`/source inspection for route and client coverage
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `git diff --check`

## Review Gates

- No endpoint is documented from memory alone.
- Both language documents have equivalent section and finding coverage.
- Every reported mismatch names concrete backend and frontend source files.
- Desired behavior is clearly separated from currently implemented behavior.
