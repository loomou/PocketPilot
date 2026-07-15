# Bootstrap Runtime Contracts

## 1. Scope / Trigger

The bootstrap establishes the Node 24 TypeScript package, unbound Fastify
composition, and the public local CLI names. `agent start` now owns the secure
listener runtime; unfinished `rekey` and `reset` commands must still fail
closed.

## 2. Signatures

- `buildApp(): Promise<FastifyInstance>` in `src/app.ts`
- `createProgram(): Command` in `src/cli/program.ts`
- CLI commands: `agent start`, `agent stop`, `agent rekey`, and `agent reset`
- Listener/process details: `process-runtime-contracts.md`

## 3. Contracts

- `GET /healthz` returns HTTP 200 and `{ "status": "ok" }` from the unbound
  remote Fastify application.
- `agent start` validates secure storage before binding either listener and
  remains foreground-controlled by the user. `agent stop` requests the
  running Agent's loopback-only internal shutdown path.
- `agent rekey` and `agent reset` remain explicit unavailable errors with exit
  code `2` until their stopped-runtime CLI layer exists.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `GET /healthz` through `app.inject()` | `200 { status: "ok" }` |
| `agent start` with no valid master key | Non-zero exit; no listener binds |
| `agent stop` with no running Agent | Non-zero exit; no process is signalled |
| `agent rekey` or `reset` | Exit `2`; runtime-unavailable error |
| Unknown CLI command | Commander error and non-zero exit |
| Attempt to start a listener from `buildApp()` | Forbidden architecture violation |

## 5. Good / Base / Bad Cases

- Good: a test constructs `buildApp()`, uses `app.inject()`, then calls
  `app.close()`; process tests construct `AgentRuntime` and retain ownership of
  real sockets.
- Base: `agent --help` lists the four stable command names.
- Bad: `agent start` binds before validating storage, exposes a local-admin
  route remotely, or treats `agent stop` as a successful no-op.

## 6. Tests Required

- `test/app.test.ts` asserts the health response through Fastify injection.
- `test/cli.test.ts` asserts the exact registered command set.
- `test/runtime/agent-runtime.test.ts` asserts listener isolation and the
  shared shutdown path.
- Package checks run lint, type-check, Vitest, and tsup on Node 24.

## 7. Wrong vs Correct

### Wrong

```ts
program.command("start").action(() => app.listen());
```

This binds an incomplete listener outside `AgentRuntime`, so it cannot validate
storage, keep local routes isolated, or coordinate shutdown.

### Correct

```ts
program.command("start").action(runStartCommand);
```

The command delegates socket ownership and the mandatory storage gate to the
runtime layer.
