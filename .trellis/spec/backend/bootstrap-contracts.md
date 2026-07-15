# Bootstrap Runtime Contracts

## 1. Scope / Trigger

The project bootstrap establishes the Node 24 TypeScript package, Fastify
composition, and the public local CLI names before secure storage or task
execution exists. The command names are a future-facing infrastructure contract,
so unfinished behavior must fail closed.

## 2. Signatures

- `buildApp(): Promise<FastifyInstance>` in `src/app.ts`
- `createProgram(): Command` in `src/cli/program.ts`
- CLI commands: `agent start`, `agent stop`, `agent rekey`, and `agent reset`

## 3. Contracts

- `GET /healthz` returns HTTP 200 and `{ "status": "ok" }` from an unbound
  Fastify application.
- The CLI exposes all four names now. Until the secure runtime exists, invoking
  any one returns exit code `2` and never binds a listener or changes data.
- No environment key, credential, database, or remote endpoint is accepted at
  this layer.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `GET /healthz` through `app.inject()` | `200 { status: "ok" }` |
| `agent start`, `stop`, `rekey`, or `reset` | Exit `2`; runtime-unavailable error |
| Unknown CLI command | Commander error and non-zero exit |
| Attempt to start a listener from `buildApp()` | Forbidden architecture violation |

## 5. Good / Base / Bad Cases

- Good: a test constructs `buildApp()`, uses `app.inject()`, then calls
  `app.close()`.
- Base: `agent --help` lists the four stable command names.
- Bad: `agent start` exits successfully without secure storage or starts an
  unauthenticated listener.

## 6. Tests Required

- `test/app.test.ts` asserts the health response through Fastify injection.
- `test/cli.test.ts` asserts the exact registered command set.
- Package checks run lint, type-check, Vitest, and tsup on Node 24.

## 7. Wrong vs Correct

### Wrong

```ts
program.command("start").action(() => undefined);
```

This looks successful while providing neither secure startup nor an error.

### Correct

```ts
program.command("start").action(() => requireRuntimeImplementation("start"));
```

The explicit non-zero result prevents an incomplete Agent from being mistaken
for a runnable secure service.
