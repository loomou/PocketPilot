# Local Admin Scaffold Contracts

## 1. Scope / Trigger

The early React/Vite/shadcn scaffold lets the configuration UI evolve without
blocking the core Agent. It intentionally precedes the functional local-admin
page and must not create a second control surface before the secure runtime.

## 2. Signatures

- `App(): JSX.Element` in `apps/local-admin/src/App.tsx`
- `Button(props: ButtonProps): JSX.Element` in
  `apps/local-admin/src/components/ui/button.tsx`
- Workspace commands: `pnpm dev:admin` and `pnpm build:admin`

## 3. Contracts

- The UI is a separate Vite workspace under `apps/local-admin`.
- The displayed configuration areas are static placeholders; no fetch, storage,
  task control, Claude credential, or configuration mutation exists.
- The future deployed bundle is served only by the separate localhost Fastify
  listener. Vite development is never a remote Agent endpoint.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `pnpm build:admin` | Vite produces a static production bundle |
| Rendering `App` | Heading and four placeholder areas are visible |
| "Agent unavailable" action | Native disabled button; no side effect |
| Attempted remote/API integration | Out of scope until local API contracts exist |

## 5. Good / Base / Bad Cases

- Good: add a visual primitive under `components/ui/` and compose it in a
  feature or root component.
- Base: static copy describes an unavailable setting without pretending it was
  saved.
- Bad: add `fetch("/v1/...")` or mobile task controls to this scaffold.

## 6. Tests Required

- `test/App.test.tsx` checks the accessible title and disabled Agent action.
- New static component behavior receives an accessible Testing Library
  assertion.
- Any local API feature added later must include API-boundary tests before UI
  persistence is claimed.

## 7. Wrong vs Correct

### Wrong

```tsx
await fetch("/v1/tasks", { method: "POST" });
```

The remote task API is not the local-admin contract and does not exist yet.

### Correct

```tsx
<Button disabled type="button">Agent unavailable</Button>
```

The scaffold stays honest about unavailable functionality until the local
listener and authenticated configuration APIs are implemented.
