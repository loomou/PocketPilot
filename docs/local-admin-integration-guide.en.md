# PocketPilot Local Admin Integration Guide

> Repository behavior audited on July 19, 2026. This document describes the implementation on the current branch, not a proposed API.

## 1. Purpose and sources of truth

This guide is for developers integrating or maintaining the browser-based PocketPilot Local Admin configuration page. It covers the loopback administration listener, configuration persistence, workspace authorization, device pairing, device revocation, audit metadata, maintenance boundaries, and the current frontend/backend alignment.

The implementation and tests are authoritative in this order:

1. Local routes and schemas: `src/local-admin/app.ts`, `src/local-admin/configuration-routes.ts`, `src/local-admin/authorized-directory-routes.ts`, and `src/auth/local-admin-routes.ts`.
2. Service and persistence owners: `src/runtime/settings.ts`, `src/tasks/settings.ts`, `src/tasks/workspace-authorization-coordinator.ts`, `src/tasks/task-manager.ts`, `src/local-admin/directory-selection-service.ts`, and `src/auth/device-auth-service.ts`.
3. Browser client and state transitions: `apps/local-admin/src/api/local-admin.ts` and `apps/local-admin/src/features/administration/`.
4. Backend and frontend tests under `test/local-admin/`, `test/auth/`, and `apps/local-admin/test/`.

The Swagger UI at `/documentation/` documents only the remote mobile `/v1` API. It deliberately excludes `/admin/*` and `/_internal/*`; this guide is the Local Admin contract reference.

## 2. Listener and security boundary

### 2.1 Listener separation

| Surface | Default address | Purpose |
| --- | --- | --- |
| Local Admin | `http://127.0.0.1:43183` | Browser UI, `/admin/*`, local Swagger UI, and terminal control endpoint |
| Remote mobile API | `http://127.0.0.1:43182` until reconfigured | Mobile `/v1/*` REST and WebSocket API |

The runtime always binds Local Admin to `127.0.0.1`. The configurable remote listener is separate. Backend tests verify that administration, authorization-management, and documentation routes return `404` on the remote listener.

`POCKETPILOT_LOCAL_ADMIN_PORT` may change the Local Admin port. The expected browser origin changes with the bound port.

### 2.2 CSRF contract

1. Fetch `GET /admin/csrf` from the same Local Admin origin.
2. For every unsafe method (`POST`, `PUT`, `PATCH`, or `DELETE`), send:
   - `Origin: http://127.0.0.1:<local-admin-port>`
   - `x-pocketpilot-csrf-token: <token returned by /admin/csrf>`
3. The browser supplies the same-origin `Origin` header automatically. A test client or non-browser integration must supply it explicitly.
4. A missing, incorrect, or differently originated request returns:

```json
{
  "code": "LOCAL_ADMIN_CSRF_REJECTED",
  "message": "This local administration request was rejected by CSRF protection."
}
```

with HTTP `403`.

`GET`, `HEAD`, and `OPTIONS` do not require the CSRF header. The internal shutdown route is excluded from CSRF because it uses a separate runtime control token; it must not be exposed as a browser button.

### 2.3 Error and response handling

Successful browser responses are validated with Zod in `apps/local-admin/src/api/local-admin.ts`. A non-2xx response shaped as `{ "code": string, "message": string }` becomes `LocalAdminApiError`. Malformed JSON or a successful response that violates the expected schema becomes `LOCAL_ADMIN_RESPONSE_INVALID`. An unstructured non-2xx response becomes `LOCAL_ADMIN_REQUEST_FAILED`.

Fastify request-schema failures normally return HTTP `400` using Fastify's validation response rather than the stable `{ code, message }` application-error shape.

## 3. Data ownership and activation timing

| Data | Storage/owner | When it changes or takes effect |
| --- | --- | --- |
| CSRF token | In-memory runtime | Regenerated when the Agent starts |
| Active listener status | Runtime process | Represents listeners bound for the current process |
| Runtime settings | Settings repository, key `runtime` | Persist immediately; listener and `mobileBaseUrl` behavior are read at the next manual Agent start |
| Task capacity and workspace roots | Settings repository, key `task-runtime` | Persist after validation; workspace authorization affects later admissions immediately |
| Configuration form draft | Browser React state | Not persisted until Save; Discard restores the last frontend snapshot |
| Native picker selection | In-memory `DirectorySelectionService` | One-time, expires after 2 minutes, maximum 32 retained selections |
| Pairing request | SQLite | Expires after 5 minutes and can register only one device |
| Paired devices and credential verifiers | SQLite | Persist until reset; plaintext access/refresh credentials are never stored |
| Audit records | SQLite | Returned as metadata only, newest first |

Important distinction: saving `mobileBaseUrl` or the remote listener does not hot-reload the active runtime. `GET /admin/status` continues to describe the currently bound listeners and startup settings until the Agent is manually stopped and started again.

## 4. Local Admin endpoint inventory

All paths below are on the Local Admin listener.

| Method | Path | Current browser use | Purpose |
| --- | --- | --- | --- |
| `GET` | `/admin/status` | Initial load and refresh | Active runtime listener/status snapshot |
| `GET` | `/admin/csrf` | Initial load and refresh | Obtain CSRF token |
| `GET` | `/admin/configuration` | Initial load and refresh | Read persisted runtime/task settings |
| `PUT` | `/admin/configuration/runtime` | Save configuration | Persist runtime settings |
| `PUT` | `/admin/configuration/tasks` | Save configuration | Validate and persist task capacity and workspace roots |
| `POST` | `/admin/directories/browse` | Authorized-directories tab | Server-side directory browser |
| `POST` | `/admin/directories/inspect` | Authorized-directories tab | Availability, canonical path, coverage, and high-risk inspection |
| `GET` | `/admin/authorized-directories` | API client exists; page does not call it | Revisioned authorization snapshot |
| `POST` | `/admin/authorized-directories/pick` | API client exists; page does not call it | Open the Agent computer's native directory picker |
| `POST` | `/admin/authorized-directories` | API client exists; page does not call it | Consume a picker selection and immediately authorize it |
| `POST` | `/admin/authorized-directories/remove` | API client exists; page does not call it | Revision-checked removal that may stop affected tasks |
| `POST` | `/admin/pairings` | Devices page | Create a QR pairing request |
| `GET` | `/admin/pairings/pending` | Initial load and refresh | List mobile registrations awaiting local approval |
| `POST` | `/admin/pairings/:pairingId/approve` | Devices page and QR dialog | Approve the matching six-digit mobile code |
| `GET` | `/admin/devices` | Initial load and refresh | List active and revoked devices |
| `POST` | `/admin/devices/:deviceId/revoke` | Devices page | Revoke a device and its live access |
| `GET` | `/admin/audits` | Initial load and refresh | Read metadata-only audit records |
| `POST` | `/_internal/shutdown` | Intentionally not exposed | Terminal-only coordinated shutdown using a control token |

## 5. Initial page load and refresh

The browser runs these six requests concurrently through `Promise.all`:

```text
GET /admin/csrf
GET /admin/configuration
GET /admin/status
GET /admin/pairings/pending
GET /admin/devices
GET /admin/audits
```

Representative responses:

```jsonc
// GET /admin/csrf
{ "token": "runtime-scoped-secret" }
```

```jsonc
// GET /admin/configuration
{
  "runtime": {
    "mobileBaseUrl": "https://agent.example.test",
    "remoteListener": { "host": "0.0.0.0", "port": 43182 }
  },
  "tasks": {
    "concurrentTaskCapacity": 3,
    "workspaceRoots": ["C:\\code"]
  }
}
```

```jsonc
// GET /admin/status
{
  "localAdminListener": { "host": "127.0.0.1", "port": 43183 },
  "mobileBaseUrl": "https://agent.example.test",
  "remoteListener": { "host": "0.0.0.0", "port": 43182 },
  "status": "running"
}
```

A fresh install omits `mobileBaseUrl`, uses remote listener `127.0.0.1:43182`, concurrent task capacity `3`, and no workspace roots.

On success, `AdministrationPage.refresh()` replaces both the server snapshot and the configuration draft. This behavior matters for the alignment findings in section 12.

## 6. Runtime and task configuration workflow

### 6.1 Runtime settings

Request:

```http
PUT /admin/configuration/runtime
Origin: http://127.0.0.1:43183
x-pocketpilot-csrf-token: <token>
Content-Type: application/json
```

```json
{
  "mobileBaseUrl": "https://agent.example.test",
  "remoteListener": {
    "host": "0.0.0.0",
    "port": 43182
  }
}
```

`mobileBaseUrl` is optional and must be an absolute URL when present. `remoteListener.host` is trimmed, 1–255 characters, and `port` is an integer from 1 through 65535. The response echoes the validated object.

### 6.2 Task settings

Request:

```http
PUT /admin/configuration/tasks
Origin: http://127.0.0.1:43183
x-pocketpilot-csrf-token: <token>
Content-Type: application/json
```

```json
{
  "concurrentTaskCapacity": 5,
  "workspaceRoots": ["C:\\code", "D:\\projects"],
  "confirmedHighRiskRoots": []
}
```

Response:

```json
{
  "concurrentTaskCapacity": 5,
  "workspaceRoots": ["C:\\code", "D:\\projects"]
}
```

Rules:

- Capacity is an integer from 1 through 1024.
- At most 1024 roots are accepted; each path is 1–4096 trimmed characters.
- A new root must be an existing, accessible, absolute directory.
- New paths are canonicalized before persistence.
- Canonically duplicate roots are rejected.
- A newly added filesystem/volume root requires the canonical path in `confirmedHighRiskRoots`.
- A previously saved but unavailable or identity-changed root is retained exactly rather than silently rewritten.
- Saves use revision checks and a serialized commit lane to avoid overwriting a concurrent policy change; exhaustion returns a retryable workspace-unavailable error.

The browser currently saves runtime settings first and task settings second. These are two independent writes, not one transaction. If the runtime write succeeds and the task write fails, the backend remains partially updated even though the page shows a single save failure.

## 7. Workspace authorization workflows

The backend currently provides two compatible but behaviorally different management surfaces over the same persisted `workspaceRoots` setting.

### 7.1 Staged browser flow used by the current page

The Configuration > Authorized directories tab uses `/admin/directories/browse`, `/admin/directories/inspect`, and finally `PUT /admin/configuration/tasks`.

Browse request:

```json
{ "path": "C:\\work" }
```

Omit `path` or send `{}` to list platform roots and home locations. Response:

```json
{
  "currentPath": "C:\\work",
  "parentPath": "C:\\",
  "entries": [
    {
      "name": "project-a",
      "path": "C:\\work\\project-a",
      "accessible": true,
      "root": false
    }
  ],
  "truncated": false
}
```

Only directories are returned. A bounded listing sets `truncated: true`. Important browse failures include `DIRECTORY_PATH_INVALID` (`400`) and `DIRECTORY_NOT_ACCESSIBLE` (`422`).

Inspect request and response:

```json
{ "paths": ["C:\\work\\project-a", "C:\\missing"] }
```

```json
[
  {
    "configuredPath": "C:\\work\\project-a",
    "canonicalPath": "C:\\work\\project-a",
    "status": "available",
    "highRisk": false
  },
  {
    "configuredPath": "C:\\missing",
    "status": "unavailable",
    "highRisk": false
  }
]
```

The response preserves request order. `coveredBy` is present when another inspected available root already covers the path. The page adds/removes rows only in the browser draft. Save persists the complete replacement list; Discard restores the last snapshot.

### 7.2 Native picker and immediate-persistence flow available in the backend

This flow prevents the add endpoint from accepting an arbitrary local path.

1. Read a revisioned snapshot:

```jsonc
// GET /admin/authorized-directories
{
  "revision": 7,
  "directories": [
    {
      "path": "C:\\code",
      "status": "available",
      "volumeRoot": false,
      "nonTerminalRuntimeCount": 2
    }
  ]
}
```

2. Open the native picker:

```http
POST /admin/authorized-directories/pick
```

```json
{
  "status": "selected",
  "selectionId": "00000000-0000-4000-8000-000000000010",
  "path": "D:\\projects",
  "volumeRoot": false,
  "expiresAt": 1900000000000
}
```

Cancellation returns `{ "status": "cancelled" }`. The Windows picker is implemented; unsupported platforms return `DIRECTORY_PICKER_UNAVAILABLE` (`503`). Concurrent picker attempts may return `DIRECTORY_PICKER_BUSY` (`409`).

3. Consume the one-time selection:

```jsonc
// POST /admin/authorized-directories
{
  "selectionId": "00000000-0000-4000-8000-000000000010",
  "volumeRootRiskAccepted": false
}
```

```json
{
  "result": "added",
  "selectedPath": "D:\\projects",
  "removedRedundantPaths": [],
  "snapshot": {
    "revision": 8,
    "directories": [
      {
        "path": "D:\\projects",
        "status": "available",
        "volumeRoot": false,
        "nonTerminalRuntimeCount": 0
      }
    ]
  }
}
```

A selection expires after 2 minutes and is consumed even if later authorization validation fails. Reuse or expiry returns `DIRECTORY_SELECTION_UNAVAILABLE` (`409`). Whole-volume authorization requires `volumeRootRiskAccepted: true`. Adding a parent may remove redundant child roots; adding an already covered child returns `result: "already-covered"` and `coveringPath`.

4. Remove with an optimistic-concurrency snapshot:

```jsonc
// POST /admin/authorized-directories/remove
{
  "path": "C:\\code",
  "revision": 8,
  "expectedNonTerminalRuntimeCount": 2,
  "runtimeStopAccepted": true
}
```

```json
{
  "removedPath": "C:\\code",
  "stoppedTaskCount": 2,
  "snapshot": {
    "revision": 9,
    "directories": []
  }
}
```

The server currently requires `runtimeStopAccepted: true`. A changed revision or affected-task count returns `AUTHORIZED_DIRECTORY_SNAPSHOT_STALE` (`409`); refresh the snapshot and ask for confirmation again. Removing an available root can terminalize non-terminal tasks that lose authorization and close their SDK connections. An unavailable saved root can still be removed and affects no running task.

## 8. Pairing workflow

### 8.1 Prerequisite

A mobile-reachable `mobileBaseUrl` must be persisted and then loaded by a newly started Agent. Without it, `POST /admin/pairings` returns `MOBILE_BASE_URL_NOT_CONFIGURED` with HTTP `409`.

### 8.2 End-to-end sequence

1. The computer creates a five-minute pairing request:

```jsonc
// POST /admin/pairings — HTTP 201
{
  "pairingId": "00000000-0000-4000-8000-000000000020",
  "expiresAt": 1900000000000,
  "qrPayload": {
    "version": 1,
    "agentId": "00000000-0000-4000-8000-000000000001",
    "baseUrl": "https://agent.example.test",
    "pairingId": "00000000-0000-4000-8000-000000000020",
    "expiresAt": 1900000000000
  }
}
```

The browser serializes `qrPayload` exactly as JSON and renders it as a QR code. The payload contains no access or refresh credential.

2. The mobile device scans the QR, generates an Ed25519 key pair, and registers through the remote listener/base URL:

```jsonc
// POST /v1/pair/{pairingId}/register
{
  "deviceDisplayName": "Pixel 9",
  "devicePublicKey": "<32-byte Ed25519 public key in base64url>"
}
```

```json
{
  "pairingId": "00000000-0000-4000-8000-000000000020",
  "verificationCode": "321654",
  "expiresAt": 1900000000000
}
```

Registration is single-use. The computer can now retrieve the pending row from `GET /admin/pairings/pending`.

3. The user enters the six-digit code displayed by the mobile device in the QR dialog or pending-pairing row. The computer approves locally:

```jsonc
// POST /admin/pairings/{pairingId}/approve
{ "verificationCode": "321654" }
```

```json
{
  "id": "00000000-0000-4000-8000-000000000021",
  "displayName": "Pixel 9",
  "createdAt": 1900000000100,
  "revokedAt": null
}
```

A wrong code returns `PAIRING_VERIFICATION_CODE_MISMATCH` (`409`). Expiry returns `PAIRING_EXPIRED` (`410`). Missing and invalid-state pairings return `PAIRING_NOT_FOUND` (`404`) or `PAIRING_NOT_PENDING` (`409`).

4. Mobile requests `/v1/pair/{pairingId}/claim-challenge`, signs the returned `message` with its private key, then posts the signature and `challengeId` to `/v1/pair/{pairingId}/claim`.

5. The remote API returns the first access token, refresh token, and access expiry. PocketPilot stores only encrypted verifiers, never issued token plaintext. A lost claim response can be recovered through another signed claim; earlier credentials are revoked.

## 9. Device listing and revocation

`GET /admin/devices` returns devices oldest first, including revoked rows:

```json
[
  {
    "id": "00000000-0000-4000-8000-000000000021",
    "displayName": "Pixel 9",
    "createdAt": 1900000000100,
    "revokedAt": null
  }
]
```

Revocation:

```http
POST /admin/devices/00000000-0000-4000-8000-000000000021/revoke
```

```json
{ "revoked": true }
```

The first revocation timestamps the device, revokes active access tokens, and immediately closes registered live connections. Repeating the request, or supplying an unknown UUID, returns `{ "revoked": false }`; the operation is idempotent from the HTTP caller's perspective. Other independently paired devices remain active.

## 10. Audit records

`GET /admin/audits` returns newest first:

```json
[
  {
    "id": "00000000-0000-4000-8000-000000000030",
    "occurredAt": 1900000000200,
    "operation": "task.created",
    "result": "success",
    "deviceId": null,
    "taskId": null
  }
]
```

The route returns metadata only. Tests verify that prompts, model output, and tool input are not exposed. Operation and result strings are server-owned opaque values; the frontend displays unknown values without translating or rewriting them.

There is no browser endpoint for filtering, pagination, deletion, or retention changes. Current filtering is client-side over the loaded snapshot.

## 11. Maintenance boundary

The browser Maintenance section is informational. Rekey and destructive reset remain terminal commands:

```text
agent rekey
agent reset --confirm RESET_AGENT_DATA
```

The coordinated shutdown route is:

```http
POST /_internal/shutdown
x-pocketpilot-control-token: <runtime control token>
```

It returns HTTP `202` with `{ "status": "stopping" }`. The token is written into runtime control state for the CLI. The Local Admin UI must not read, store, or expose it.

## 12. Frontend/backend alignment audit

Classification: **Aligned** means the current page follows the backend contract; **Partial** means the main call is correct but state or UX reconciliation is incomplete; **Mismatch** means behavior conflicts with the implemented contract or intended route; **Not exposed** means the backend capability intentionally has no browser control.

| Area | Result | Severity | Evidence and impact | Recommended action |
| --- | --- | --- | --- | --- |
| Initial snapshot | Aligned | — | `loadLocalAdminSnapshot()` calls all six mounted GET routes and validates every response. Backend routes exist in `src/local-admin/app.ts`, `configuration-routes.ts`, and `src/auth/local-admin-routes.ts`. | Keep schemas synchronized with backend route schemas. |
| CSRF | Aligned | — | Every API-client mutation adds `x-pocketpilot-csrf-token`; same-origin browser fetch supplies the required Origin. Backend enforces both in `src/local-admin/csrf.ts`. | Non-browser tests/integrations must set Origin explicitly. |
| Runtime configuration | Aligned | — | Form fields match `runtimeSettingsSchema`; UI states that listener changes require restart. | Keep active `/admin/status` distinct from saved `/admin/configuration`. |
| Combined configuration save | Partial | High | `AdministrationPage.saveConfiguration()` performs runtime PUT and then task PUT. The backend has two independent persistence operations and no transaction. A task-validation failure can leave runtime settings saved while the page reports one failure and retains the old snapshot. | Reconcile after each write, save tasks first if preferable, or add a transactional aggregate endpoint. At minimum display partial-save status and reload persisted data. |
| Authorized-directories tab, staged workflow | Aligned | — | `workspace-authorization.tsx` uses browse/inspect and edits `configuration.tasks.workspaceRoots`; `App.test.tsx` verifies changes remain discardable and high-risk confirmation is sent on Save. | Document it explicitly as staged replacement semantics. |
| Native picker authorization API | Not exposed | Medium | The API client implements `loadAuthorizedDirectories`, `pickAuthorizedDirectory`, `addAuthorizedDirectory`, and `removeAuthorizedDirectory`, but no component imports or calls them. The visible tab uses server browsing instead of the Agent computer's native picker and does not use revision/task-impact data. | Decide on one product contract. If the requirement is “choose folders on the computer with the native picker,” migrate the tab to `/admin/authorized-directories/*`; otherwise remove/deprecate the unused client surface and clarify why both backend flows exist. |
| Native removal safety | Not exposed | High if native flow is expected | Current row deletion only changes the browser draft. It never confirms `nonTerminalRuntimeCount`, sends `revision`, handles `AUTHORIZED_DIRECTORY_SNAPSHOT_STALE`, or tells the user that tasks may stop. Those semantics exist only in `TaskManager.removeAuthorizedDirectory()`. | When adopting the native flow, refresh the snapshot before confirmation, show affected task count, require explicit stop acceptance, and replace state from the returned snapshot. |
| Pairing QR generation | Aligned | — | Browser uses the backend `qrPayload` verbatim, renders QR, and shows expiry. `DeviceAuthService.createPairing()` owns identity, base URL, and five-minute expiry. | Do not construct QR identity or base URL in the browser. |
| QR dialog code approval | Aligned | — | `devices-view.tsx` displays QR and a six-digit numeric input together; approval posts `{ verificationCode }` to the generated pairing ID. `App.test.tsx` verifies filtering to six digits and the exact request body. | Keep mobile code as the source of user verification. |
| Pending pairing list | Aligned | — | Initial load calls `/admin/pairings/pending`; backend lists registered, unexpired, unapproved pairings in registration order. | Treat any older spec saying this route is not called as stale documentation. |
| Pairing/device mutation refresh versus unsaved configuration | Mismatch | Medium | After QR generation, approval, or revocation, `refresh(true)` replaces `configurationDraft` with server configuration. `preserveNotice` preserves only the notice. Unsaved configuration or workspace edits can disappear without warning. Existing tests cover locale preservation but not mutation-triggered refresh preservation. | Preserve a dirty draft across non-configuration refreshes, or prompt before replacing it; add regression tests for all three mutations. |
| Device revocation | Aligned with reconciliation caveat | Medium | Endpoint and response match; backend immediately revokes access and closes live connections. The page refreshes device state, but the same refresh can erase a dirty configuration draft. | Keep returned/loaded device state authoritative and fix draft preservation. |
| Audit view | Aligned | — | The page reads metadata-only records and performs client-side search/filtering. Unknown operation/result values remain opaque. | Add server pagination only if audit volume requires it. |
| Response validation | Aligned | — | Browser Zod schemas reject malformed successful payloads; tests cover invalid browse/inspection and snapshot responses. | Continue adding schema tests when endpoint fields change. |
| Maintenance shutdown/rekey/reset | Not exposed | — | UI provides terminal instructions only; the control-token shutdown endpoint is not called. | Preserve the terminal-only trust boundary. |

### 12.1 Overall conclusion

The configuration page matches the backend for its selected **staged configuration** workflow and for pairing, device, audit, status, and CSRF contracts. It does **not** currently use the backend's native picker/revisioned authorized-directory workflow, even though API-client functions for that workflow already exist. Two integration risks remain in current code: configuration saving can partially succeed, and unrelated pairing/device refreshes can silently overwrite unsaved configuration drafts.

## 13. Error and recovery reference

| Code | Typical status | Recovery |
| --- | --- | --- |
| `LOCAL_ADMIN_CSRF_REJECTED` | `403` | Reload CSRF token from the same Local Admin origin; never retry cross-origin. |
| `LOCAL_ADMIN_RESPONSE_INVALID` | Client-generated | Treat as backend/frontend version mismatch; do not render unvalidated data. |
| `LOCAL_ADMIN_REQUEST_FAILED` | Client-generated | Show generic local-Agent failure and allow retry. |
| `DIRECTORY_PATH_INVALID` | `400` | Submit an absolute directory path or return to roots/home. |
| `DIRECTORY_NOT_ACCESSIBLE` | `422` | Choose another accessible directory. |
| `WORKSPACE_PATH_INVALID` | `422` | Correct capacity/root payload. |
| `WORKSPACE_PATH_UNAVAILABLE` | `422` | Refresh/inspect, remove or restore unavailable new roots, then retry. |
| `WORKSPACE_PATH_NOT_DIRECTORY` | `422` | Choose a directory rather than a file. |
| `WORKSPACE_ROOT_DUPLICATE` | `422` | Remove the canonically duplicate root. |
| `WORKSPACE_ROOT_HIGH_RISK_CONFIRMATION_REQUIRED` | `422` | Show explicit whole-volume warning and resend canonical path in `confirmedHighRiskRoots`. |
| `DIRECTORY_PICKER_BUSY` | `409` | Wait for the active native picker to complete. |
| `DIRECTORY_PICKER_UNAVAILABLE` | `503` | Explain platform/runtime limitation; use the staged browser flow only if product policy permits it. |
| `DIRECTORY_SELECTION_UNAVAILABLE` | `409` | Open the picker again; the selection expired or was consumed. |
| `VOLUME_ROOT_RISK_NOT_ACCEPTED` | `422` | Obtain explicit whole-volume consent and repeat with the risk flag. |
| `AUTHORIZED_DIRECTORY_INVALID` | `422` | Pick an accessible directory again. |
| `AUTHORIZED_DIRECTORY_NOT_FOUND` | `404` | Reload the authorization snapshot. |
| `AUTHORIZED_DIRECTORY_SNAPSHOT_STALE` | `409` | Reload snapshot and repeat user confirmation with the new revision/count. |
| `MOBILE_BASE_URL_NOT_CONFIGURED` | `409` | Save a mobile-reachable URL, manually restart the Agent, then create a pairing. |
| `PAIRING_NOT_FOUND` | `404` | Generate a new QR if the local request no longer exists. |
| `PAIRING_ALREADY_USED` | `409` | Generate a new QR; registration is single-use. |
| `PAIRING_NOT_PENDING` | `409` | Refresh pending pairings; it was already approved or is not registered. |
| `PAIRING_VERIFICATION_CODE_MISMATCH` | `409` | Re-enter the exact six-digit code shown on mobile. |
| `PAIRING_EXPIRED` | `410` | Generate and scan a new QR. |
| `LOCAL_ADMIN_OPERATION_FAILED` | `500` | Show a generic failure; backend intentionally hides storage/runtime details. |

## 14. Integration checklist

### Startup and security

- [ ] Open the UI only from the loopback Local Admin listener.
- [ ] Fetch a fresh CSRF token after every Agent restart or page reload.
- [ ] Send both same-origin `Origin` and CSRF header for unsafe requests.
- [ ] Verify `/admin/*` and `/documentation/*` are unavailable on the remote listener.

### Configuration

- [ ] Display saved configuration separately from active status.
- [ ] Tell users runtime listener and mobile URL changes require manual restart.
- [ ] Handle the two configuration PUTs as independently fallible writes.
- [ ] Preserve or explicitly discard dirty drafts during refresh and unrelated mutations.

### Workspace authorization

- [ ] Choose and document either staged browse/inspect/save or native picker/immediate persistence as the product workflow.
- [ ] Canonicalize and inspect before adding a staged root.
- [ ] Require explicit confirmation for a filesystem/volume root.
- [ ] If using native removal, show affected task count and retry stale snapshots from a fresh GET.
- [ ] Replace client state with the mutation response snapshot; do not predict revision changes.

### Pairing and devices

- [ ] Configure and activate a mobile-reachable base URL before creating a QR.
- [ ] Encode the returned `qrPayload` verbatim.
- [ ] Accept only the six-digit code returned to the registering mobile device.
- [ ] Let mobile claim credentials only after local approval and signed challenge proof.
- [ ] On revocation, treat live mobile connections and access tokens as immediately invalid.

### Audit and maintenance

- [ ] Render audit operation/result values as opaque server data.
- [ ] Never expose prompt, output, tool input, master key, control token, or stored credential verifier.
- [ ] Keep shutdown, rekey, and reset in the terminal-controlled trust boundary.
