# Local Admin Application Contracts

## 1. Scope / Trigger

Apply this contract when changing the React/Vite localhost configuration page
or its browser API client. The page is an operational surface for one local
Agent and is not a second mobile/task control application.

## 2. Signatures

- `App(): JSX.Element` composes `AdministrationPage`.
- `loadLocalAdminSnapshot(): Promise<LocalAdminSnapshot>` owns initial reads.
- `loadPendingPairings(signal?): Promise<PendingPairing[]>` owns the scoped
  pairing-registration refresh.
- Browser mutations: `saveRuntimeSettings`, `saveTaskSettings`,
  `createPairing`, `approvePairing`, and `revokeDevice`.
- Directory mutations: `pickAuthorizedDirectory`, `addAuthorizedDirectory`,
  `removeAuthorizedDirectory`, and `loadAuthorizedDirectories`.
- Workspace commands: `pnpm dev:admin` and `pnpm build:admin`.

## 3. Contracts

- `src/api/local-admin.ts` is the single owner of `/admin/*` payload schemas.
  Every `response.json()` value is `unknown` until a Zod schema accepts it.
- Initial load obtains CSRF, configuration, status, pending pairings, devices,
  audits, and the authorized-directory snapshot. Writes include
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
- A generated QR starts one serial pending-pairing poller for that QR's
  lifetime. It reads only `/admin/pairings/pending`, replaces only
  `snapshot.pendingPairings`, retries transient failure without changing the
  notice, and aborts the in-flight request when the QR is replaced or the page
  unmounts. It never refreshes the complete snapshot because that would discard
  staged configuration edits.
- `App.tsx` remains composition-only. Stateful application behavior lives in
  `features/administration`; shadcn-style primitives remain under
  `components/ui`.
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
| Pending-pairing poll fails transiently | Preserve the QR, notice, snapshot, and form edits; retry until QR expiry. |
| Device is already revoked | Show revoked state and no revoke action. |

## 5. Good / Base / Bad Cases

- Good: one API decoder validates server data, the feature consumes inferred
  types, and a save sends the current typed settings with the CSRF token.
- Good: capacity is edited to `9`, Add returns a new directory snapshot, and
  the visible capacity remains `9` without a configuration PUT.
- Base: cancelling the picker or removal confirmation leaves server and form
  state unchanged.
- Base: empty pending/device/audit arrays render explicit empty rows while the
  configuration form stays usable.
- Base: a phone registers after the one-time QR mutation response; the scoped
  poll reveals its pending row and Mobile code input without another Generate
  QR action.
- Bad: casting `await response.json()` to a component-local interface,
  sending a manually typed directory path, refreshing the whole snapshot after
  Add/Remove, or adding mobile task operations to the localhost page.

## 6. Tests Required

- Testing Library renders loaded configuration values plus pairing, device,
  status, and audit sections from mocked local API responses.
- Save behavior asserts both PUT requests contain the fetched CSRF token and
  JSON content type.
- Pairing polling tests start from an empty pending list, tolerate one failed
  poll, reveal the later registered device after one QR generation, preserve a
  staged form edit, and assert unmount aborts the poll signal.
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
const pendingPairings = await loadPendingPairings(signal);
setSnapshot((current) =>
  current === undefined ? current : { ...current, pendingPairings },
);
```

The API boundary validates once and exports the inferred type to the feature.
Directory responses follow the same rule; components never recreate their
interfaces or accept arbitrary add paths.
