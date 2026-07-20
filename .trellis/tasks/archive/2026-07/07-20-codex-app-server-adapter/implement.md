# Codex App Server adapter implementation plan

## Preconditions

- Keep this task in `planning` until its blocking dependency is complete and its
  PRD/design are reviewed.
- Load all applicable backend Trellis specs with `trellis-before-dev` before
  changing source.
- Revalidate the installed Codex App Server version and generated schema; do not
  rely on temporary paths recorded during research.

## Sequence

1. Define Codex JSON-RPC guards, method allowlist, version/capability probe,
   diagnostics mapping, and provider-owned native types/fixtures.
2. Implement the stdio App Server bridge, initialize handshake, correlation,
   bounded writes, process failure, timeout, and deterministic shutdown.
3. Implement thread list/read/start/resume with source inclusion, workspace
   filtering, negotiated pagination, and bounded history fallback.
4. Bind common tasks to Codex native identity and implement turn start, steer,
   interrupt, close/detach, recovery, and capacity behavior.
5. Implement native frame journaling, out-of-band cursor replay, unresolved
   server-request retention, and provider isolation.
6. Implement concurrent command/file/permission/MCP approval handling with
   native decisions and complete cleanup paths.
7. Implement capability-driven model, effort, approval, sandbox, permission,
   and collaboration controls with path authorization.
8. Add offline protocol/contract tests and a caller-configured
   `pnpm test:codex:live` suite.
9. Update Codex provider specs, OpenAPI/native protocol documentation, setup,
   diagnostics, and future-adapter guidance.

## Validation

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:codex:live
```

The live suite requires an absolute caller-provided
`CODEX_APP_SERVER_TEST_CWD`; ordinary `pnpm test` skips it.

## Review gates

- Review the JSON-RPC allowlist and path authorization before exposing streams.
- Review process shutdown and reconnect before approval handling.
- Review concurrent approval ownership before live testing.
- Do not claim Codex parity without live evidence for streaming, interrupt,
  history, resume, and shutdown.
