# Process and Listener Runtime Contracts

## Scenario: Manually Started Agent Listeners

### 1. Scope / Trigger

Apply this contract when changing `agent start`, `agent stop`, listener
configuration, Fastify composition, local administration routes, or coordinated
process shutdown. It prevents the remote mobile surface from accidentally
exposing localhost-only administration or an unauthenticated control endpoint.

### 2. Signatures

```ts
buildRemoteApiApp(): Promise<FastifyInstance>;
buildLocalAdminApp(options: LocalAdminAppOptions): Promise<FastifyInstance>;
new AgentRuntime(options).start(): Promise<AgentRuntimeStatus>;
AgentRuntime.shutdown(): Promise<void>;
requestRuntimeShutdown(runtimeControlPath: string): Promise<void>;
acquireAgentLock(databasePath: string): Promise<ReleaseAgentLock>;
runRekeyCommand(environment?, writeOutput?): Promise<void>;
runResetCommand(confirmation, environment?, writeOutput?): Promise<void>;
readRuntimeSettings(settingsRepository): RuntimeSettings;
writeRuntimeSettings(settingsRepository, settings): void;
```

The CLI commands are `agent start`, `agent stop`, `agent rekey`, and
`agent reset`. The runtime settings are stored under the `runtime` settings key
and use the Zod `runtimeSettingsSchema`.

### 3. Contracts

- `agent start` first validates `AGENT_MASTER_KEY`, opens/migrates SQLite,
  authenticates its persistent key verifier, prunes expired storage, and
  deletes transient event-overflow rows. A missing, invalid, or unauthenticated
  master key fails before either listener binds.
- Before opening SQLite, the runtime acquires an exclusive lock derived from
  the database path. The same lock covers stopped-only rekey/reset commands;
  it is held for the full runtime or maintenance operation and released only
  after storage closes.
- The remote Fastify app and local-admin Fastify app are separate factories and
  are unbound until `AgentRuntime` owns their sockets. The remote app may expose
  only non-sensitive `/healthz` until device authentication and `/v1` routes
  exist. It must never mount `/admin/*` or `/_internal/*` routes.
- The remote default is `127.0.0.1:43182`. Persisted remote host/port and an
  optional mobile base URL are read once during manual startup; writing a new
  setting never changes a live listener.
- The local-admin listener always binds to `127.0.0.1`; its default port is
  `43183`. `GET /admin/status` and `GET /admin/csrf` are local-only.
- Every unsafe non-internal local-admin request requires an exact
  `Origin: http://127.0.0.1:<bound-port>` and the current
  `x-pocketpilot-csrf-token`. The temporary `/_internal/shutdown` path instead
  requires a random runtime-control token and is only used by `agent stop`; no
  browser page receives that token.
- After both listeners bind, the runtime atomically writes a short-lived local
  control-state file containing only the loopback port and random shutdown
  token. `agent stop` reads it and POSTs only to `127.0.0.1`. Shutdown through
  that request, `SIGINT` (Ctrl+C), and `SIGTERM` must flow through the same
  `AgentRuntime.shutdown()` path.
- A stopping runtime removes the control-state file only if its token still
  matches. A failed second startup must therefore never remove another running
  Agent's stop credential.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| `AGENT_MASTER_KEY` absent or invalid | Throw `MasterKeyError`; do not bind a listener. |
| Well-formed key fails persisted verifier | Throw `StorageCryptoError` with `AUTHENTICATION_FAILED`; do not bind. |
| Runtime or maintenance already owns data lock | Throw `AgentMaintenanceError` with `AGENT_MAINTENANCE_LOCKED`. |
| Data lock cannot be acquired/released safely | Throw `AgentMaintenanceError` with `AGENT_MAINTENANCE_LOCK_UNAVAILABLE`. |
| No control-state file on `agent stop` | Throw `RuntimeControlError` with `RUNTIME_NOT_RUNNING`. |
| Malformed control-state JSON | Throw `RuntimeControlError` with `RUNTIME_STATE_INVALID`. |
| Loopback control listener cannot be reached | Throw `RuntimeControlError` with `RUNTIME_CONTROL_UNAVAILABLE`. |
| Shutdown request does not return HTTP 202 | Throw `RuntimeControlError` with `RUNTIME_CONTROL_REJECTED`. |
| Remote request for `/admin/status` | Return 404, never a proxied local response. |
| Unsafe local-admin request without valid origin/token | Return HTTP 403 and `LOCAL_ADMIN_CSRF_REJECTED`. |
| Missing/wrong internal control token | Return HTTP 401 and `RUNTIME_CONTROL_UNAUTHORIZED`. |

### 5. Good / Base / Bad Cases

- Good: a user starts the Agent with a valid key, exposes only the configured
  remote listener through their own tunnel, and runs `agent stop`; both
  listeners close and the control-state file disappears.
- Base: a fresh database establishes its key verifier and, with no `runtime`
  setting, binds remote health on `127.0.0.1:43182` and local administration on
  `127.0.0.1:43183`.
- Bad: opening SQLite before acquiring the data lock, registering local-admin
  routes on the remote app, or deleting an unmatched control-state file during
  startup failure.

### 6. Tests Required

- Remote app injection proves `/healthz` returns 200 and `/admin/status`
  returns 404.
- Local app injection proves status is available, unsafe requests without
  CSRF fail with 403, valid same-origin CSRF reaches normal routing, and the
  internal shutdown token is checked separately.
- Runtime integration starts both listeners on temporary ports, verifies
  remote/local route isolation, calls `requestRuntimeShutdown`, waits for the
  shared shutdown promise, and verifies control-state cleanup.
- Runtime startup with no master key rejects before creating the database or
  control-state file.
- Runtime tests prove a second owner is rejected, shutdown releases the lock,
  and a wrong persisted master key is rejected before binding.
- Maintenance tests prove rekey/reset cannot overlap a running Agent or each
  other.
- Control-state tests prove a runtime cannot remove a file whose token belongs
  to another runtime.

### 7. Wrong vs Correct

#### Wrong

```ts
const storage = openStorage({ databasePath });
await runAgent(storage);
```

This lets a stopped-only maintenance command open the same database while the
Agent is live.

#### Correct

```ts
const release = await acquireAgentLock(databasePath);
const storage = openStorage({ databasePath });

try {
  await runAgent(storage);
} finally {
  storage.close();
  await release();
}
```

The runtime owns the lock for the same lifetime as SQLite and all listeners,
so stopped-only maintenance cannot overlap live Agent work.
