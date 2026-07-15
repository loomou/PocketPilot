# Backend Quality Guidelines

## Required Tooling

- Target Node.js 24 and use strict TypeScript. `tsconfig.json` enables
  `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before a
  backend commit.
- Biome owns formatting and linting. Do not introduce a second formatter.
- Husky runs lint-staged before commits; commitlint requires Conventional
  Commit messages.

## Required Patterns

- Validate HTTP contracts at the Fastify boundary with Zod schemas and the
  Fastify Zod type provider.
- Build Fastify apps without listening so tests use `app.inject()` and process
  startup retains sole ownership of sockets.
- Represent intentionally unavailable safety-critical commands with an
  explicit error and non-zero exit code. Do not turn an unfinished command
  into a successful no-op.

## Forbidden Patterns

- Do not bind a listener from a route or application factory.
- Do not use `any`, unchecked JSON casts, or unvalidated request payloads.
- Do not bypass hooks with `--no-verify` except for a documented emergency.
- Do not make `agent start` expose an incomplete, unauthenticated runtime.

## Tests Required

- A new route needs an `app.inject()` assertion for its status and response.
- A CLI command change needs a test that command registration or its observable
  exit behavior remains stable.
- A release candidate must pass all four package scripts on Node 24.
