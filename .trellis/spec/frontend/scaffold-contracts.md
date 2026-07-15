# Local Admin Application Contracts

## 1. Scope / Trigger

Apply this contract when changing the React/Vite localhost configuration page
or its browser API client. The page is an operational surface for one local
Agent and is not a second mobile/task control application.

## 2. Signatures

- `App(): JSX.Element` composes `AdministrationPage`.
- `loadLocalAdminSnapshot(): Promise<LocalAdminSnapshot>` owns initial reads.
- Browser mutations: `saveRuntimeSettings`, `saveTaskSettings`,
  `createPairing`, `approvePairing`, and `revokeDevice`.
- Workspace commands: `pnpm dev:admin` and `pnpm build:admin`.

## 3. Contracts

- `src/api/local-admin.ts` is the single owner of `/admin/*` payload schemas.
  Every `response.json()` value is `unknown` until a Zod schema accepts it.
- Initial load obtains CSRF, configuration, status, pending pairings, devices,
  and audits. Writes include `x-pocketpilot-csrf-token`; configuration writes
  use JSON request bodies.
- The page exposes Agent status, listener/base URL settings, workspace roots,
  concurrency, QR generation, pairing approval, device revocation, audit
  metadata, and terminal-only rekey/reset guidance.
- QR rendering encodes the complete server-returned `qrPayload` as JSON. The
  UI never invents an Agent ID, pairing ID, base URL, or expiry.
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
| Pairing approval code is not six digits | Keep the Approve action disabled. |
| Device is already revoked | Show revoked state and no revoke action. |

## 5. Good / Base / Bad Cases

- Good: one API decoder validates server data, the feature consumes inferred
  types, and a save sends the current typed settings with the CSRF token.
- Base: empty pending/device/audit arrays render explicit empty rows while the
  configuration form stays usable.
- Bad: casting `await response.json()` to a component-local interface,
  constructing a QR from partial fields, or adding mobile task operations to
  the localhost page.

## 6. Tests Required

- Testing Library renders loaded configuration values plus pairing, device,
  status, and audit sections from mocked local API responses.
- Save behavior asserts both PUT requests contain the fetched CSRF token and
  JSON content type.
- Backend/static integration separately proves the bundle is never served by
  the remote listener; a component test cannot establish listener isolation.
- Root lint, type-check, test, and production build include the workspace.

## 7. Wrong vs Correct

### Wrong

```ts
const configuration = (await response.json()) as Configuration;
```

The component trusts unknown HTTP data and privately redefines the server
contract.

### Correct

```ts
const payload: unknown = await response.json();
const configuration = configurationSchema.parse(payload);
```

The API boundary validates once and exports the inferred type to the feature.
