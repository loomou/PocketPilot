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
- User-facing console labels follow the approved Simplified Chinese interface.
  Server-returned operation names, identifiers, URLs, and command strings stay
  unchanged rather than being rewritten in components.
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
- Save behavior asserts both PUT requests contain the fetched CSRF token and
  JSON content type.
- Pairing tests assert that QR generation and code entry make no approval
  request, one Approve click sends the current pairing ID and six-digit code,
  rejected approval preserves the QR/code, and successful approval updates only
  devices while preserving staged form edits.
- Add/Remove tests assert picker-selected payloads, volume/stale confirmation,
  current revision/count, and preservation of staged capacity/runtime values.
- Backend/static integration separately proves the bundle is never served by
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
