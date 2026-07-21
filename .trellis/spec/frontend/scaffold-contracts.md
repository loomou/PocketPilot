# Local Admin Application Contracts

## 1. Scope / Trigger

Apply this contract when changing the React/Vite localhost configuration page
or its browser API client. The page is an operational surface for one local
Agent and is not a second mobile/task control application.

## 2. Signatures

- `App(): JSX.Element` composes `AdministrationPage`.
- `AdminSection` is the closed navigation union: `overview`, `configuration`,
  `devices`, `audit`, and `maintenance`.
- `loadLocalAdminSnapshot(): Promise<LocalAdminSnapshot>` owns initial reads.
- Browser mutations: `saveRuntimeSettings`, `saveTaskSettings`,
  `createPairing`, `approvePairing`, and `revokeDevice`.
- Directory mutations: `pickAuthorizedDirectory`, `addAuthorizedDirectory`,
  `removeAuthorizedDirectory`, and `loadAuthorizedDirectories`.
- Workspace commands: `pnpm dev:admin` and `pnpm build:admin`.

## 3. Contracts

- `src/api/local-admin.ts` is the single owner of `/admin/*` payload schemas.
  Every `response.json()` value is `unknown` until a Zod schema accepts it.
- Initial load obtains CSRF, configuration, status, devices, audits, and the
  authorized-directory snapshot. Writes include
  `x-pocketpilot-csrf-token`; configuration writes use JSON request bodies.
- The page exposes Agent status, listener/base URL settings, workspace roots,
  concurrency, QR generation, pairing approval, device revocation, audit
  metadata, and terminal-only rekey/reset guidance.
- Workspace roots render in a separate **Authorized directories** security
  section and are never a text field. Add opens the Agent-native picker and
  commits its opaque selection ID; Remove sends the displayed path, snapshot
  revision, affected-runtime count, and explicit confirmation. Both replace
  only the returned directory snapshot and preserve unsaved configuration
  form edits.
- QR rendering encodes the complete server-returned `qrPayload` as JSON. The
  UI never invents an Agent ID, pairing ID, base URL, or expiry.
- A generated QR immediately exposes one Mobile code input bound to its
  server-returned `pairingId`. QR generation and input changes are local UI
  state; only the explicit Approve action calls
  `/admin/pairings/:pairingId/approve`. A successful response replaces only the
  device collection and clears the active QR/code, preserving staged form
  edits. The page does not call `/admin/pairings/pending`.
- `App.tsx` remains composition-only. Stateful application behavior lives in
  `features/administration`; shadcn-style primitives remain under
  `components/ui`.
- The production console is desktop-only with a persistent sidebar and a
  minimum 1080px application width. Section navigation uses local React state;
  do not add a router for these five views.
- User-facing console labels support Simplified Chinese and English through
  the registry/provider contract in `i18n-guidelines.md`. Server-returned
  operation names, identifiers, URLs, device names, paths, and command strings
  stay unchanged rather than being rewritten in components.
- Configuration edits remain a local draft with an explicit dirty-state save
  bar. Runtime and task settings are saved together through the two existing
  validated writes; there is no autosave.
- The page never calls `/v1`, starts/stops the Agent, controls a Claude task, or
  reads/writes Claude credentials and configuration.
- Vite emits production assets to `dist/local-admin`, which is part of the
  root package's published `dist` tree.

## 4. Validation & Error Matrix

| Condition | UI behavior |
| --- | --- |
| A successful response fails its Zod schema | Show the stable invalid-response error; do not place payload data in state. |
| A local API returns `{ code, message }` with non-2xx status | Show its safe message and keep current state. |
| Initial load fails | Keep the page shell visible and show an error notice. |
| Configuration save succeeds | Update the typed snapshot and state that listener changes apply on next start. |
| Native picker returns `cancelled` | Show a no-change notice; make no add request. |
| Selected row is a volume root | Require browser confirmation before sending `volumeRootRiskAccepted: true`. |
| Removal returns `AUTHORIZED_DIRECTORY_SNAPSHOT_STALE` | Reload only directories, keep form edits, and require a new confirmation. |
| Pairing approval code is not six digits | Keep the Approve action disabled. |
| Approval returns a local API error | Preserve the QR, code, notice context, and form edits. |
| Device is already revoked | Show revoked state and no revoke action. |

## 5. Good / Base / Bad Cases

- Good: one API decoder validates server data, the feature consumes inferred
  types, and a save sends the current typed settings with the CSRF token.
- Good: capacity is edited to `9`, Add returns a new directory snapshot, and
  the visible capacity remains `9` without a configuration PUT.
- Base: cancelling the picker or removal confirmation leaves server and form
  state unchanged.
- Base: before QR generation the approval section asks the operator to generate
  a QR; after generation it shows the single Mobile code input.
- Base: a phone's displayed code is not sent anywhere until the operator clicks
  Approve; the returned device is added without a full snapshot refresh.
- Bad: casting `await response.json()` to a component-local interface,
  sending a manually typed directory path, refreshing the whole snapshot after
  Add/Remove, or adding mobile task operations to the localhost page.

## 6. Tests Required

- Testing Library renders loaded configuration values plus pairing, device,
  status, and audit sections from mocked local API responses.
- Component tests navigate through the five section buttons using their
  accessible names and verify the approved observable view structure.
- Configuration tests change the local draft, assert the dirty-state save
  action, and verify the save notice appears only after both validated writes.
- Save behavior asserts both PUT paths and payloads contain the expected
  values, fetched CSRF token, and JSON content type.
- Pairing tests assert that QR generation and code entry make no approval
  request, one Approve click sends the current pairing ID and six-digit code,
  rejected approval preserves the QR/code, and successful approval updates only
  devices while preserving staged form edits.
- Add/Remove tests assert picker-selected payloads, volume/stale confirmation,
  current revision/count, and preservation of staged capacity/runtime values.
- Locale tests assert startup resolution, immediate switching, `<html lang>`,
  persistence, state preservation, locale-neutral notice rerendering, and the
  opaque server-value boundary described in `i18n-guidelines.md`.- Backend/static integration separately proves the bundle is never served by
  the remote listener; a component test cannot establish listener isolation.
- Root lint, type-check, test, and production build include the workspace.

## 7. Wrong vs Correct

### Wrong

```ts
const configuration = (await response.json()) as Configuration;
await refresh(); // Full snapshot polling also overwrites staged form edits.
```

The component trusts unknown HTTP data and privately redefines the server
contract.

### Correct

```ts
const payload: unknown = await response.json();
const configuration = configurationSchema.parse(payload);
const device = await approvePairing(csrfToken, pairingId, verificationCode);
setSnapshot((current) =>
  current === undefined ? current : { ...current, devices: [...current.devices, device] },
);
```

The API boundary validates once and exports the inferred type to the feature.
Directory responses follow the same rule; components never recreate their
interfaces or accept arbitrary add paths.

## Authorized Directories UI Addendum

### 1. Scope / Trigger

Apply this contract when changing the Configuration workspace authorization
controls, directory browser, or the local-admin client calls that support them.

### 2. Signatures

```ts
browseDirectories(csrfToken, path?): Promise<DirectoryListing>;
inspectDirectories(csrfToken, paths): Promise<WorkspaceInspection[]>;
saveTaskSettings(csrfToken, settings, confirmedHighRiskRoots?): Promise<TaskSettings>;
<WorkspaceAuthorization
  workspaceRoots
  confirmedHighRiskRoots
  onWorkspaceRootsChange
  onConfirmedHighRiskRootsChange
/>;
```

The API module owns Zod response decoding and the feature consumes inferred
response types; transport-only confirmation fields remain outside component
settings types.

### 3. Contracts

- Configuration has General and Authorized directories tabs inside one form and
  one Save/Discard bar. Root additions/removals update only the local draft
  until Save succeeds.
- The authorization table shows configured path, available/unavailable status,
  canonical path when available, coverage metadata, high-risk state, and Remove.
  Nested roots remain visible even when covered by another root.
- The browser modal supports virtual roots/home shortcuts, breadcrumbs/up,
  absolute address navigation, directory-only rows, deterministic truncation
  notices, keyboard Escape/cancel, focus restoration, and a second confirmation
  for high-risk filesystem/volume/UNC roots.
- Paths and server-owned directory data render opaque. Duplicate, unavailable,
  invalid, and backend policy errors become stable localized notices without
  translating the path itself.

### 4. Validation & Error Matrix

| Condition | UI behavior |
| --- | --- |
| Browse/inspect response fails Zod decoding | Keep the draft unchanged and show invalid-response notice. |
| Directory listing is truncated | Show a localized truncation notice and allow visible navigation only. |
| Selected path is unavailable/non-directory | Keep modal open and show safe error. |
| Selected path is duplicate | Do not change the draft; show duplicate feedback. |
| Selected path is high-risk | Require explicit second confirmation before adding it. |
| Discard or successful Save | Reconcile draft and transient confirmations with the loaded server snapshot. |
| Locale switches while modal/tab/draft is active | Preserve tab, modal, address, listing, draft rows, and confirmation state. |

### 5. Good / Base / Bad Cases

- Good: Add inspects the selected directory, appends its canonical path to the
  draft, and leaves Save enabled without persisting until the user saves.
- Base: removing a draft row removes its matching confirmation state and the
  next Save sends only the current roots plus write-only confirmations.
- Bad: using a textarea as the authorization editor, trusting `response.json()`
  with a cast, or remounting the page on locale change.

### 6. Tests Required

- Assert API requests, CSRF headers, JSON payloads, and Zod rejection for valid,
  malformed, and non-2xx browse/inspect responses.
- Assert tab persistence, draft add/remove, duplicate/high-risk flows,
  Save/Discard reconciliation, modal Escape/focus behavior, breadcrumbs/up,
  direct absolute navigation, directory-only filtering, and truncation notices.
- Assert locale switching preserves authorization UI state and leaves paths,
  IDs, and other server-owned values unchanged.

### 7. Wrong vs Correct

#### Wrong

```tsx
const payload = (await response.json()) as DirectoryListing;
setConfiguration({ ...configuration, workspaceRoots: [...roots, path] });
```

This trusts an unknown response and mutates the server snapshot before Save.

#### Correct

```tsx
const listing = await browseDirectories(csrfToken, address);
onWorkspaceRootsChange([...draftRoots, inspection.canonicalPath]);
```

The API boundary validates the response and the feature emits a draft-only
state change until the shared Save action commits it.
