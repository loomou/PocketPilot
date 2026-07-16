# Environment Configuration Contracts

## 1. Scope / Trigger

Apply this contract when adding or changing a bootstrap setting that is not
owned by the localhost administration page. It preserves an explicit boundary
between PocketPilot startup configuration, inherited process state, and Claude
Agent SDK configuration.

## 2. Signatures

```ts
loadPocketPilotEnvironment({ cwd?, environment? }): NodeJS.ProcessEnv;
readAgentDataDirectory(environment): string | undefined;
readLocalAdminPort(environment): number | undefined;
createProgramActions(environment): ProgramActions;
runStartCommand(environment?): Promise<void>;
runStopCommand(environment?): Promise<void>;
runRekeyCommand(environment?, writeOutput?): Promise<void>;
runResetCommand(confirmation, environment?, writeOutput?): Promise<void>;
```

The supported dotenv keys are `AGENT_MASTER_KEY`, `AGENT_NEW_MASTER_KEY`,
`POCKETPILOT_DATA_DIR`, and `POCKETPILOT_LOCAL_ADMIN_PORT`.

## 3. Contracts

- Read only `path.join(cwd ?? process.cwd(), ".env")`; do not search a parent
  directory, the Agent data directory, or an inferred project root.
- Parse with `dotenv.parse()` into a copied environment. Do not call
  `dotenv.config()` or mutate `process.env`.
- Copy only allowlisted keys whose process-environment value is `undefined`.
  An explicitly present process value, including an empty string, wins and is
  then validated normally.
- Load one environment snapshot before Commander dispatch and pass that same
  object to start, stop, rekey, and reset.
- `POCKETPILOT_LOCAL_ADMIN_PORT` is optional, accepts only decimal integers in
  `1..65535`, and changes only the loopback listener. The default remains
  `43183`.
- `POCKETPILOT_DATA_DIR` must be non-empty when present. Relative paths resolve
  from the startup working directory through the existing runtime path owner.
- PocketPilot deliberately ignores `ANTHROPIC_*`, Claude configuration, and
  arbitrary dotenv keys. Claude continues to inherit only the actual process
  environment owned by the user.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Startup-directory `.env` is absent | Continue with the copied process environment. |
| `.env` exists but cannot be read | `EnvironmentConfigurationError` with `DOTENV_READ_FAILED`; bind no listener and reveal no file contents. |
| Required master key remains missing/empty/malformed | Existing `MasterKeyError`; open no SQLite and bind no listener. |
| Data directory is empty or whitespace | `ENVIRONMENT_VALUE_INVALID`. |
| Local-admin port is empty, non-decimal, zero, or above 65535 | `ENVIRONMENT_VALUE_INVALID`. |
| Process value and dotenv value both exist | Use the process value; never silently fall back after validation fails. |
| Unknown or Claude-related dotenv key exists | Ignore it in the PocketPilot environment snapshot. |

## 5. Good / Base / Bad Cases

- Good: a dedicated launch directory contains a protected `.env`; every CLI
  command run there uses the same data directory and the configured loopback
  administration port.
- Base: no `.env` exists and the user supplies the master key through the
  process environment; all other settings use existing defaults.
- Bad: parent-directory discovery loads a different project's secrets,
  `dotenv.config()` imports arbitrary keys globally, or stop/rekey/reset use a
  different data directory than start.

## 6. Tests Required

- Unit-test exact-child-directory selection while a parent `.env` exists.
- Unit-test the four-key allowlist, process precedence, explicit empty values,
  input immutability, missing files, and unreadable files.
- Unit-test data-directory and local-port validation at boundary values.
- CLI/runtime tests must prove invalid configuration fails before storage or
  listener creation and expected error text contains no secret.
- The Windows packed-install smoke test must start and maintain the Agent from
  the installed launch directory with parent PocketPilot variables removed.

## 7. Wrong vs Correct

### Wrong

```ts
dotenv.config();
const port = Number(process.env.POCKETPILOT_LOCAL_ADMIN_PORT);
```

This mutates global state, imports unrelated keys, may discover the wrong file,
and accepts numeric formats outside the contract.

### Correct

```ts
const environment = loadPocketPilotEnvironment({ cwd: process.cwd() });
const actions = createProgramActions(environment);
const port = readLocalAdminPort(environment);
```

The loader owns file selection and precedence, and typed readers own validation
before any runtime resource is opened.
