# Local Administration Contracts

## 1. Scope / Trigger

Apply this contract when changing the localhost configuration APIs, local
static asset delivery, pairing/device administration, or audit viewing. The
local administration surface is a security boundary and must never be mounted
on the remote mobile listener.

## 2. Signatures

```ts
buildLocalAdminApp(options): Promise<FastifyInstance>;
GET /documentation/;
GET /documentation/json;
GET /documentation/yaml;
registerConfigurationRoutes(app, { settingsRepository, sqlite }): void;
GET /admin/configuration;
PUT /admin/configuration/runtime;
PUT /admin/configuration/tasks;
GET /admin/audits;
```

Pairing and device administration retain their existing local routes:
`POST /admin/pairings`, `GET /admin/pairings/pending`,
`POST /admin/pairings/:pairingId/approve`, `GET /admin/devices`, and
`POST /admin/devices/:deviceId/revoke`.

## 3. Contracts

- `GET /admin/configuration` returns Zod-validated `runtime` and `tasks`
  settings, including fresh-install defaults when no row exists.
- The runtime write accepts the optional mobile base URL plus the remote host
  and port. The task-policy write accepts concurrency capacity and workspace
  roots. Listener changes are persisted but apply only on the next manual
  Agent start.
- `GET /admin/audits` returns only `id`, `occurredAt`, `deviceId`, `taskId`,
  `operation`, and `result`, ordered newest first. Prompts, model output, tool
  parameters, credentials, and secrets have no response field.
- Every unsafe `/admin/*` request passes the local app's exact-origin and CSRF
  hook. The page receives the CSRF token from `GET /admin/csrf`; it never
  receives the runtime shutdown credential.
- Built assets live under `dist/local-admin` and are registered only by
  `buildLocalAdminApp`. `buildRemoteApiApp` serves neither these assets nor any
  `/admin/*` route.
- When supplied a generated mobile OpenAPI document, the local app serves
  Swagger UI plus raw JSON/YAML below `/documentation`. Those routes document
  the remote `/v1` contract but remain local-only and disable interactive
  request execution by default.
- The surface has no task controls, Claude credential/configuration editor, or
  Agent start/stop action. Rekey/reset are guidance for stopped-terminal use.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Unsafe local write lacks exact origin or CSRF token | HTTP 403 with `LOCAL_ADMIN_CSRF_REJECTED`; persist nothing. |
| Runtime/task payload violates its shared Zod schema | HTTP 400; persist nothing. |
| Mobile base URL is absent during pairing creation | Existing `MOBILE_BASE_URL_NOT_CONFIGURED` response; create no pairing. |
| Audit table is empty | HTTP 200 with `[]`. |
| Static build directory is absent | Local APIs still start; no static route is registered. |
| Remote request targets `/admin/*` or the local page | HTTP 404. |
| Remote request targets `/documentation/*` | HTTP 404. |

## 5. Good / Base / Bad Cases

- Good: the browser obtains its CSRF token, saves both validated setting
  records, and the next manual start binds the new remote listener.
- Base: a fresh database returns `127.0.0.1:43182`, capacity `3`, and no
  workspace roots or audit records.
- Bad: mounting `@fastify/static` or `registerConfigurationRoutes` on the
  remote app, returning an audit payload field that can contain user content,
  or applying listener changes to the live socket.

## 6. Tests Required

- Fastify injection proves fresh defaults, CSRF rejection, valid same-origin
  persistence, and metadata-only audit projection.
- Remote-app injection proves `/admin/configuration` and the management page
  are 404.
- Static-app injection proves a local `index.html` is served when the build
  directory exists.
- Local/remote injection proves Swagger UI and raw documents are local-only and
  coexist with the React static root.
- A built CLI smoke test starts with fresh storage, returns the local page and
  status, returns remote 404 for `/admin/status`, and shuts down through
  `agent stop`.

## 7. Wrong vs Correct

### Wrong

```ts
remoteApp.register(fastifyStatic, { root: adminBuild });
remoteApp.get("/admin/audits", () => database.select().from(auditRecords));
```

This exposes the computer administration surface through the user's tunnel
and couples the response to every future database column.

### Correct

```ts
await localApp.register(fastifyStatic, { root: adminBuild });
registerConfigurationRoutes(localApp, { settingsRepository, sqlite });
```

The audit route uses an explicit metadata projection and both registrations
exist only in the loopback app factory.
