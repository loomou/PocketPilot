# Bootstrap Runtime Contracts

## 1. Scope / Trigger

The bootstrap establishes the Node 24 TypeScript package, unbound Fastify
composition, and the public local CLI names. `agent start` owns the secure
listener runtime; `rekey` and `reset` are stopped-only storage maintenance
commands.

## 2. Signatures

- `buildApp(): Promise<FastifyInstance>` in `src/app.ts`
- `createProgram(actions?: ProgramActions): Command` in `src/cli/program.ts`
- `loadPocketPilotEnvironment(options?): NodeJS.ProcessEnv` in
  `src/config/environment.ts`
- `buildMobileOpenApiDocument(): Promise<OpenAPIV3.Document>` in
  `src/api-docs/mobile-openapi.ts`
- CLI commands: `agent start`, `agent stop`, `agent rekey`, and `agent reset`
- `runRekeyCommand(environment?, writeOutput?): Promise<void>`
- `runResetCommand(confirmation, environment?, writeOutput?): Promise<void>`
- Listener/process details: `process-runtime-contracts.md`

## 3. Contracts

- `GET /healthz` returns HTTP 200 and `{ "status": "ok" }` from the unbound
  remote Fastify application.
- `agent start` validates secure storage before binding either listener and
  remains foreground-controlled by the user. `agent stop` requests the
  running Agent's loopback-only internal shutdown path.
- `agent rekey` requires valid, distinct `AGENT_MASTER_KEY` and
  `AGENT_NEW_MASTER_KEY` values, obtains the Agent data lock, and atomically
  re-encrypts sensitive storage plus its persistent key verifier.
- `agent reset --confirm RESET_AGENT_DATA` validates the literal confirmation
  before acquiring the lock or opening SQLite. It deliberately does not
  require the lost old master key.
- `src/cli.ts` translates expected runtime, maintenance, storage, and key
  errors to safe stderr text and exit code `1`.
- `src/cli.ts` loads one allowlisted startup-directory environment snapshot
  before Commander dispatch. See `environment-configuration-contracts.md`.
- The production build emits the remote mobile contract before packaging
  runtime assets. See `api-documentation-contracts.md`.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `GET /healthz` through `app.inject()` | `200 { status: "ok" }` |
| `agent start` with no valid master key | Non-zero exit; no listener binds |
| `agent stop` with no running Agent | Non-zero exit; no process is signalled |
| `agent rekey` while runtime/maintenance owns the data lock | Non-zero exit; `AGENT_MAINTENANCE_LOCKED` |
| `agent rekey` with equal old/new keys | Non-zero exit; `MASTER_KEYS_IDENTICAL` |
| `agent reset` without the exact confirmation | Commander or `StorageResetConfirmationError`; storage is not opened |
| Maintenance command with no Agent database | Non-zero exit; `AGENT_DATA_NOT_FOUND` |
| Unknown CLI command | Commander error and non-zero exit |
| Attempt to start a listener from `buildApp()` | Forbidden architecture violation |

## 5. Good / Base / Bad Cases

- Good: a test constructs `buildApp()`, uses `app.inject()`, then calls
  `app.close()`; process tests construct `AgentRuntime` and retain ownership of
  real sockets.
- Base: `agent --help` lists the four stable command names and `agent reset`
  requires `--confirm <value>`.
- Bad: `agent start` binds before validating storage, `reset` opens the
  database before validating confirmation, or a maintenance command runs
  concurrently with the Agent.

## 6. Tests Required

- `test/app.test.ts` asserts the health response through Fastify injection.
- `test/cli.test.ts` asserts the exact registered command set.
- `test/runtime/maintenance-commands.test.ts` asserts rekey/reset dispatch,
  key behavior, lock exclusion, pre-open confirmation, and safe reset scope.
- `test/runtime/agent-runtime.test.ts` asserts listener isolation and the
  shared shutdown path.
- Package checks run lint, type-check, Vitest, tsup, and the Windows packed
  installation smoke test on Node 24 with pnpm 10.14.x.

## 7. Wrong vs Correct

### Wrong

```ts
program.command("reset").action(() => resetAgentData(sqlite, "unchecked"));
```

This bypasses Commander confirmation, the stopped-Agent data lock, and the
pre-open confirmation boundary.

### Correct

```ts
program
  .command("reset")
  .requiredOption("--confirm <value>")
  .action(({ confirm }) => actions.reset(confirm));
```

The command delegates validation, lock ownership, storage opening, and reset
scope to the maintenance runtime boundary.
