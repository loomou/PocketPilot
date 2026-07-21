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
GET /admin/authorized-directories;
POST /admin/authorized-directories/pick;
POST /admin/authorized-directories;
POST /admin/authorized-directories/remove;
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
  and port. The task-policy write accepts concurrency capacity only and
  preserves the latest internal `workspaceRoots`; listener changes are
  persisted but apply only on the next manual Agent start.
- Authorized directories are a separate immediate-persistence security
  surface. `GET` returns `{ revision, directories }`, where each row contains
  canonical `path`, availability, volume-root risk, and affected non-terminal
  runtime count. It is not part of the ordinary configuration Save action.
- `POST .../pick` opens one injected Windows native picker and returns either
  `{ status: "cancelled" }` or an expiring opaque `selectionId` plus its
  canonical display path. The add route accepts only that single-use ID and a
  volume-root risk boolean; it never accepts a caller-supplied path.
- Removal accepts only an exact current row plus snapshot `revision`, expected
  runtime count, and explicit stop acceptance. A mismatch stops nothing and
  requires the browser to refresh/reconfirm. Successful P0 cleanup completes
  before the route returns the next snapshot.
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
| Picker is unsupported, busy, aborted, timed out, or malformed | Stable `DIRECTORY_PICKER_*` error; expose no PowerShell/process text. |
| Selection ID expired or was already consumed | HTTP 409 `DIRECTORY_SELECTION_UNAVAILABLE`; write no root. |
| Volume/UNC root lacks explicit risk acceptance | HTTP 422 `VOLUME_ROOT_RISK_NOT_ACCEPTED`; write no root. |
| Removal revision/count is stale | HTTP 409 `AUTHORIZED_DIRECTORY_SNAPSHOT_STALE`; stop no runtime. |
| Unexpected storage/runtime failure | HTTP 500 `LOCAL_ADMIN_OPERATION_FAILED`; expose no raw exception text. |
| Mobile base URL is absent during pairing creation | Existing `MOBILE_BASE_URL_NOT_CONFIGURED` response; create no pairing. |
| Audit table is empty | HTTP 200 with `[]`. |
| Static build directory is absent | Local APIs still start; no static route is registered. |
| Remote request targets `/admin/*` or the local page | HTTP 404. |
| Remote request targets `/documentation/*` | HTTP 404. |

## 5. Good / Base / Bad Cases

- Good: the browser obtains its CSRF token, saves both validated setting
  records, and the next manual start binds the new remote listener.
- Good: a picker token adds one canonical directory immediately while unsaved
  listener/capacity form edits remain unchanged.
- Base: cancelling the native picker creates no token and changes no setting;
  a covered child returns `already-covered`.
- Base: a fresh database returns `127.0.0.1:43182`, capacity `3`, and no
  workspace roots or audit records.
- Bad: mounting `@fastify/static` or `registerConfigurationRoutes` on the
  remote app, returning an audit payload field that can contain user content,
  accepting an arbitrary add path, or applying listener changes to the live
  socket.

## 6. Tests Required

- Fastify injection proves fresh defaults, CSRF rejection, valid same-origin
  persistence, and metadata-only audit projection.
- Picker/route tests prove cancellation, single-use/expiry, directory
  revalidation, volume confirmation, safe process failures, stale removal,
  and capacity/root lost-update prevention.
- Remote injection uses each route's actual method and proves every directory
  list/mutation URL is 404.
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
localApp.post("/admin/authorized-directories", ({ body }) =>
  saveRoot(body.path),
);
```

This exposes the computer administration surface through the user's tunnel
and couples the response to every future database column.

### Correct

```ts
await localApp.register(fastifyStatic, { root: adminBuild });
registerConfigurationRoutes(localApp, { settingsRepository, sqlite });
registerAuthorizedDirectoryRoutes(localApp, {
  directorySelectionService,
  taskManager,
});
```

The audit route uses an explicit metadata projection and both registrations
exist only in the loopback app factory.

## Workspace Authorization and Directory Browser Addendum

### 1. Scope / Trigger

Apply these rules when the local page edits authorized workspace roots or
browses/inspects local directories. These endpoints are local-only security
boundaries and must not be registered on the remote API listener.

### 2. Signatures

```ts
POST /admin/directories/browse
// body: { path?: string }
// 200: { currentPath, parentPath, entries, truncated }

POST /admin/directories/inspect
// body: { paths: string[] }
// 200: WorkspaceRootInspection[]

PUT /admin/configuration/tasks
// body: TaskRuntimeSettings & { confirmedHighRiskRoots?: string[] }
// 200: TaskRuntimeSettings
```

`DirectoryBrowserService` is injected into the local app. It exposes virtual
roots/home shortcuts, absolute navigation, parent navigation, directories-only
entries, deterministic ordering, and bounded/truncation-aware results.

### 3. Contracts

- Browse and inspect responses are metadata-only: return paths, names, access,
  status, coverage, risk, and truncation metadata; never return file contents,
  directory contents beyond the bounded entry metadata, credentials, or task
  data.
- Browse accepts an omitted path for virtual roots and accepts only absolute
  paths for direct navigation. Files are filtered out. Invalid, inaccessible,
  and malformed paths use safe structured errors.
- The task-settings response remains the persisted `TaskRuntimeSettings` shape.
  `confirmedHighRiskRoots` is write-only transport input and must not reach the
  settings repository, response schema, or frontend component settings type.
- All unsafe local requests retain exact-origin and CSRF protection, including
  directory browse/inspect and task-settings replacement.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Relative/invalid browse path | Safe 4xx error; reveal no directory metadata. |
| Inaccessible browse/inspect path | Safe unavailable error; reveal no contents. |
| Listing exceeds service bound | Return deterministic prefix plus `truncated: true`. |
| Request targets remote listener | HTTP 404; no local filesystem access. |
| Missing origin or CSRF on unsafe local route | HTTP 403 `LOCAL_ADMIN_CSRF_REJECTED`; persist/read no protected data. |
| High-risk root confirmation omitted | HTTP 403/422 workspace policy error; persist nothing. |

### 5. Good / Base / Bad Cases

- Good: the browser opens virtual roots, navigates only to absolute directories,
  submits one inspected canonical path, and keeps the result in the draft until
  Save.
- Base: an empty root listing returns a valid bounded response with no entries;
  a large listing returns stable ordering and `truncated: true`.
- Bad: register these routes on `buildRemoteApiApp`, return file entries or
  contents, or return `confirmedHighRiskRoots` from the task-settings response.

### 6. Tests Required

- Inject local browse/inspect requests for virtual roots, absolute paths,
  parent/up navigation, directory-only filtering, invalid/inaccessible paths,
  deterministic bounds, truncation, and safe errors.
- Assert exact-origin/CSRF rejection and remote-listener 404 isolation.
- Assert task-settings writes persist canonical available roots, preserve
  unavailable saved rows, reject new unavailable/duplicate/high-risk-unconfirmed
  roots, and keep the response free of confirmation fields.

### 7. Wrong vs Correct

#### Wrong

```ts
remoteApp.post('/admin/directories/browse', async (request) =>
  fs.readdir(request.body.path));
```

This exposes local filesystem metadata through the remote listener and bypasses
CSRF, bounds, and response validation.

#### Correct

```ts
localApp.post('/admin/directories/browse', { schema }, (request) =>
  directoryBrowserService.browse(request.body.path));
```

The injected service enforces local-only routing, safe metadata projection,
absolute-path validation, deterministic limits, and the local security hooks.
