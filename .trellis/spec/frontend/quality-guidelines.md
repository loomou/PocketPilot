# Frontend Quality Guidelines

## Required Checks

- Run root `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` with
  pnpm 10.14 before committing frontend changes. Root commands include the
  local-admin workspace.
- Biome has one root configuration. Do not add a nested `biome.json` below
  `apps/local-admin`; add its paths to the root configuration instead.
- Vite's production build is required for any Tailwind or shadcn component
  change because it verifies the CSS transformation pipeline.

## Tests Required

- A root or feature component needs a Vitest/Testing Library test for its
  primary accessible output.
- Shared controls need tests for externally observable state, such as the
  native disabled state of the scaffold button.
- Mock only endpoints defined by the local-admin backend contract, and keep
  response fixtures valid under the browser Zod schemas.

## Forbidden Patterns

- Do not run a Vite dev server from the Agent process or expose it through the
  remote listener.
- Do not introduce a second formatter, nested Biome root configuration, or CSS
  framework beside Tailwind.
- Do not claim a mutation succeeded until its validated local API response is
  received.
