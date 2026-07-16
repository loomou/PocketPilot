# Technical Design — Environment Configuration and API Documentation

## Architecture

The change adds two independent boundaries to the existing CLI runtime:

```text
process environment ─┐
                     ├─> allowlisted dotenv loader ─> validated command env
cwd/.env ────────────┘                                  │
                                                       ├─> start/stop
                                                       └─> rekey/reset

Zod route schemas ─> remote Fastify app ─> @fastify/swagger ─> OpenAPI 3.1
                                                   │
                              ┌────────────────────┴──────────────────┐
                              v                                       v
                  localhost Swagger UI                 dist/openapi/mobile-v1.json
```

Neither boundary changes the SQLite-backed settings owned by the localhost
page. Dotenv supplies only bootstrap values needed before that page is
available; OpenAPI documents only the mobile `/v1` contract.

## Dependency Selection

Pin exact versions, following the repository's existing dependency policy:

| Package | Version | Purpose / compatibility |
| --- | --- | --- |
| `dotenv` | `17.4.2` | Parse the exact startup-directory `.env` without mutating global environment state. Supports Node 24. |
| `@fastify/swagger` | `9.8.1` | Fastify 5-compatible dynamic OpenAPI generation. |
| `@fastify/swagger-ui` | `5.2.6` | Fastify 5 / Swagger plugin 9-compatible local UI. Do not take the latest 6.x major while the project remains on Fastify 5. |

`fastify-type-provider-zod@7.0.0` already exports
`jsonSchemaTransform` for `@fastify/swagger`; no second Zod-to-schema library is
needed.

## Dotenv Boundary

### Loading and precedence

Add a configuration owner such as `src/config/environment.ts` with a pure,
injectable boundary:

```ts
loadPocketPilotEnvironment({
  cwd,
  environment,
}): NodeJS.ProcessEnv;

readLocalAdminPort(environment): number;
```

The loader reads only `path.join(cwd, ".env")`. It does not search parents,
consult the Agent data directory, or accept a dotenv-path setting. A missing
file is allowed. Other read failures become a typed, secret-safe configuration
error before command dispatch.

Use `dotenv.parse()` rather than `dotenv.config()`. Start from a copy of the
existing process environment, then copy only missing allowlisted keys from the
parsed file:

1. `AGENT_MASTER_KEY`
2. `AGENT_NEW_MASTER_KEY`
3. `POCKETPILOT_DATA_DIR`
4. `POCKETPILOT_LOCAL_ADMIN_PORT`

An existing process-environment key wins even when its value is empty; the
normal validator then rejects the invalid value rather than silently falling
back to the file. Unknown dotenv keys are ignored. This permits a shared
working-directory `.env` without deliberately importing Claude credentials or
application-specific variables into PocketPilot's environment copy.

### Command wiring

Load the environment once in `src/cli.ts`, before creating the Commander
program. Create default program actions bound to that immutable environment
snapshot. All four commands consume it:

- `start`: master key, data directory, and local-admin port.
- `stop`: data directory, so it finds the matching runtime-control file.
- `rekey`: data directory plus old/new master keys.
- `reset`: data directory only; lost-key reset remains supported.

`POCKETPILOT_LOCAL_ADMIN_PORT` is optional and defaults to `43183`. Parse it as
an integer in `1..65535` before constructing `AgentRuntime`. It controls only
the loopback listener and never changes `LOCAL_ADMIN_HOST`.

### Secret handling

- Never print the dotenv contents, parsed map, master keys, or source line.
- Add a committed `.env.example` containing names and safe placeholders only.
- The existing `.gitignore` already ignores `.env` and `.env.*` while allowing
  `.env.example`; preserve it.
- Document that `AGENT_NEW_MASTER_KEY` is temporary: after successful rekey,
  replace `AGENT_MASTER_KEY` and remove the new-key entry.
- Do not interpret `ANTHROPIC_*`, Claude configuration, or arbitrary dotenv
  values. Existing OS-level environment variables remain outside this loader's
  scope and continue to be inherited normally by the local SDK process.

## OpenAPI Generation

### Single source of truth

Register `@fastify/swagger` before any remote route registration and use
`jsonSchemaTransform`. Route Zod schemas remain the executable request/response
contracts and generate OpenAPI 3.1. No hand-maintained duplicate REST path list
is permitted.

Add the missing documentation metadata to route schemas:

- operation ID, summary, description, and tags;
- bearer security requirements on access-token-protected operations;
- an OpenAPI bearer security scheme;
- stable `{ code, message }` responses for authentication and task errors;
- descriptions/examples that contain no real credentials, prompts, task
  output, tool input, or machine paths.

Pairing registration/claim and refresh proof routes remain callable without an
access bearer and therefore have no bearer security requirement. Session,
capability, task-control, and event-subscription operations declare bearer
authentication.

### Complete route registration for generation

The current remote app conditionally registers route families based on concrete
services. Narrow each route registrar to the interface methods it actually
uses (`Pick<...>` or explicit structural interfaces). Provide typed
documentation-only service stubs whose handlers are never invoked during
`app.ready()`.

A single `buildMobileOpenApiDocument()` function builds the same remote app
route graph with those stubs, waits for Fastify readiness, calls `app.swagger()`,
adds the WebSocket extension, and closes the unbound app. Both runtime UI and
the build generator consume this function.

### WebSocket extension

Export the runtime Zod schemas currently private to `task-event-routes.ts` for:

- client `subscribe`;
- server `subscribed`;
- server `event` envelope;
- server `error`.

Use their generated JSON Schemas in an `x-websocket` extension attached to
`/v1/events`. The extension also records:

- Bearer authentication during the WebSocket handshake;
- close code `4003` for authentication/revocation failure;
- subscription validation error behavior;
- monotonic `afterCursor` replay semantics and live handoff;
- the fact that Swagger UI displays but does not execute the WebSocket flow.

The runtime parser and sender must consume the same exported schemas/types, so
documentation cannot drift into a parallel message definition.

## Documentation Delivery

### Local runtime UI

`buildLocalAdminApp` receives the generated mobile OpenAPI document and
registers `@fastify/swagger` in static mode plus `@fastify/swagger-ui` at
`/documentation`. The UI and raw JSON/YAML endpoints are GET-only and remain
bound to `127.0.0.1` with the rest of local administration.

The remote Fastify app registers only the generator plugin/decorator, not the
Swagger UI plugin or a documentation route. Requests for `/documentation` and
its JSON/YAML paths must return 404 remotely.

The existing React static root and Swagger UI assets must coexist without
catch-all route or reply-decoration conflicts. Integration tests own this
registration-order contract.

### Build artifact

Add a generator entry/script that calls `buildMobileOpenApiDocument()` and
writes deterministic, pretty-printed JSON to
`dist/openapi/mobile-v1.json`. The build order is:

1. compile the CLI and generator entry;
2. run the generator;
3. copy Drizzle assets;
4. build the local-admin React assets.

The package already includes the complete `dist` directory, so no new npm
`files` entry is needed. The Windows release smoke test must assert that the
artifact exists in the installed tarball and matches the local raw-document
endpoint after normalizing JSON formatting.

## Error and Compatibility Contracts

- A missing `.env` is not an error; missing required `AGENT_MASTER_KEY` remains
  the existing `MASTER_KEY_MISSING` failure.
- An unreadable `.env` or invalid local-admin port produces a typed CLI-safe
  error before the Agent opens storage or binds listeners.
- Existing malformed master key and data-lock behavior is unchanged.
- The local-admin port change applies only at the next manual start because it
  is a bootstrap value.
- Existing SQLite databases and settings require no migration.
- OpenAPI version is `3.1.0`; API info version follows the `/v1` protocol
  contract rather than the package release number.
- The generated document must be deterministic across repeated builds on the
  same source tree.

## Security Boundaries

- Dotenv values never appear in OpenAPI examples, logs, local responses, or
  SQLite.
- Swagger UI is local-only and introduces no remote unauthenticated route.
- OpenAPI documents public contract shapes, not stored device/session values.
- Local administration and internal shutdown routes are excluded by building
  the document from the remote route graph only.
- Documentation generation never starts listeners, opens production storage,
  launches Claude, or requires a real master key.

## Rollback

- Dotenv loading can be rolled back by removing the loader and continuing to
  supply the existing environment variables directly; no persisted data is
  changed.
- Documentation plugins and generated assets can be removed without changing
  HTTP handler behavior because they consume existing route schemas.
- If Swagger UI registration conflicts with the React static server, retain
  the generated JSON artifact and disable only the runtime UI while correcting
  the local static composition.
