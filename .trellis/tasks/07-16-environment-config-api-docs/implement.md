# Implementation Plan — Environment Configuration and API Documentation

## Preconditions

- User-approved dotenv allowlist:
  `AGENT_MASTER_KEY`, `AGENT_NEW_MASTER_KEY`, `POCKETPILOT_DATA_DIR`, and
  `POCKETPILOT_LOCAL_ADMIN_PORT`.
- User-approved exact startup working-directory `.env`; process environment
  wins and parent discovery is forbidden.
- User-approved remote `/v1` documentation scope, local-only Swagger UI plus a
  packaged JSON artifact, and OpenAPI 3.1 `x-websocket` instead of AsyncAPI.
- Do not run `task.py start` until `prd.md`, `design.md`, and this plan have
  been reviewed and approved.

## Ordered Work

1. **Add and validate configuration dependencies**
   - Pin `dotenv@17.4.2`, `@fastify/swagger@9.8.1`, and the Fastify 5-compatible
     `@fastify/swagger-ui@5.2.6`.
   - Add the pure allowlisted dotenv loader and typed configuration error.
   - Add local-admin port parsing with the existing `43183` default.
   - Unit-test missing file, exact cwd selection, process precedence, unknown
     key filtering, empty explicit values, unreadable file, and invalid ports.

2. **Wire one environment snapshot through every CLI command**
   - Load dotenv before Commander dispatch without mutating `process.env`.
   - Bind start, stop, rekey, and reset actions to the merged environment.
   - Pass the snapshot and parsed local-admin port into `AgentRuntime`.
   - Preserve lost-key reset, runtime data-path lookup, key zeroing, and safe
     top-level error translation.
   - Add `.env.example` and update CLI/runtime tests.

3. **Make remote schemas documentation-ready**
   - Register dynamic Swagger generation before remote routes with
     `jsonSchemaTransform` and OpenAPI 3.1 metadata.
   - Narrow route service dependencies to structural interfaces so a typed,
     side-effect-free documentation app can register every route.
   - Add operation IDs, tags, descriptions, bearer security, and complete
     stable error response schemas to auth and task routes.
   - Keep handler behavior and Zod validation unchanged; add regression tests
     for representative error responses.

4. **Share and document the WebSocket protocol**
   - Export Zod schemas for subscribe/subscribed/event/error messages and make
     runtime parsing/sending consume them.
   - Generate their JSON Schemas and attach `x-websocket` to `/v1/events` with
     auth, close-code, replay, and reconnection semantics.
   - Test that generated WebSocket schemas accept runtime messages and reject
     malformed examples.

5. **Create the reusable OpenAPI document generator**
   - Implement `buildMobileOpenApiDocument()` using the complete unbound
     remote route graph and typed no-op service dependencies.
   - Assert the document is OpenAPI 3.1, contains every expected `/v1` path,
     excludes `/admin/*`, `/_internal/*`, and secrets, and is deterministic.
   - Ensure the unbound Fastify app always closes on generation failure.

6. **Serve documentation only on localhost**
   - Pass the generated document into `buildLocalAdminApp`.
   - Register static Swagger plus Swagger UI at `/documentation` while keeping
     the React root and existing local APIs functional.
   - Test local UI/raw JSON success and remote 404 isolation.

7. **Generate and package the build artifact**
   - Add a compiled generator entry and run it from `pnpm build` before final
     asset packaging completes.
   - Emit deterministic `dist/openapi/mobile-v1.json` and confirm `pnpm pack`
     includes it.
   - Extend the Windows release smoke test to compare the installed artifact
     with the running local raw document and verify the configured local-admin
     port from `.env`.

8. **Update operator and integration documentation**
   - Document cwd `.env`, allowlist, precedence, secret storage, port behavior,
     rekey cleanup, and examples in `README.md`.
   - Document the local Swagger URL, raw document, packaged JSON path, bearer
     authentication, and WebSocket non-execution limitation.
   - Update the relevant Trellis backend specs for bootstrap, process runtime,
     local administration, API schema generation, directory ownership,
     logging, and release quality gates.

9. **Run final verification**
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm build`
   - Generate twice and compare OpenAPI artifact bytes.
   - Inspect `pnpm pack` contents for the OpenAPI JSON and Swagger runtime
     dependencies.
   - `pnpm test:release:windows`
   - Review generated documents for credential-like strings and local-only
     route leakage.

## Validation Matrix

| Area | Required assertions |
| --- | --- |
| Dotenv | Exact cwd file only; OS env wins; allowlist only; missing file allowed; bad port/read failure is pre-bind and secret-safe. |
| CLI | All four commands use the same snapshot; start receives local port; stop/rekey/reset resolve the dotenv data directory. |
| HTTP OpenAPI | Every remote `/v1` HTTP route appears with operation ID, schemas, auth, and stable error bodies. |
| WebSocket | `/v1/events` has `x-websocket` with shared Zod message schemas, Bearer handshake, close `4003`, and cursor semantics. |
| Isolation | Local UI/JSON succeed; every documentation URL is 404 on the remote listener; admin/internal paths are absent from JSON. |
| Packaging | `dist/openapi/mobile-v1.json` is deterministic and ships in the tarball; installed UI serves the same contract. |
| Security | No key, token, prompt/output, tool data, full machine path, or local control credential appears in docs or logs. |

## Risk and Rollback Points

| Risk | Mitigation / rollback |
| --- | --- |
| `dotenv.config()` imports arbitrary Claude/project keys | Use `dotenv.parse()` and copy only the approved allowlist into an environment snapshot. |
| OS env is accidentally overridden | Test key-by-key precedence including explicit empty values. |
| Fastify plugin major is incompatible | Pin Swagger 9.x and Swagger UI 5.2.6 for Fastify 5; do not accept UI 6.x through a floating range. |
| Docs omit conditional route families | Generate through one complete typed remote-app factory and assert the exact path set. |
| Swagger UI leaks through the tunnel | Register UI only in `buildLocalAdminApp`; add remote negative tests and release-smoke assertions. |
| WebSocket docs drift from runtime | Export and reuse the runtime Zod schemas; forbid a second hand-written message model. |
| React static root conflicts with Swagger assets | Cover both route families in one integration test; temporarily retain JSON artifact if UI must be rolled back. |
| Build artifact differs from runtime document | Both call `buildMobileOpenApiDocument()`; compare normalized documents in tests/smoke. |

## Likely Files

- `.env.example`, `README.md`, `package.json`, `pnpm-lock.yaml`
- `src/config/environment.ts`, `src/runtime/commands.ts`, `src/cli.ts`,
  `src/cli/program.ts`, `src/runtime/agent-runtime.ts`, `src/runtime/errors.ts`
- `src/http/create-http-app.ts`, `src/auth/remote-routes.ts`,
  `src/auth/http.ts`, `src/remote-api/app.ts`,
  `src/remote-api/task-routes.ts`, `src/remote-api/task-event-routes.ts`
- `src/api-docs/*`, `scripts/generate-openapi.*`,
  `scripts/windows-release-smoke.ps1`, `tsup.config.ts`
- `src/local-admin/app.ts`
- Unit/integration tests under `test/config`, `test/remote-api`,
  `test/local-admin`, and `test/runtime`
- Relevant `.trellis/spec/backend/*` documents
