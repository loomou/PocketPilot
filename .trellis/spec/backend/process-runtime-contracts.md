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
readRuntimeSettings(settingsRepository): RuntimeSettings;
writeRuntimeSettings(settingsRepository, settings): void;
```

The CLI commands are `agent start` and `agent stop`. The runtime settings are
stored under the `runtime` settings key and use the Zod `runtimeSettingsSchema`.

### 3. Contracts

- `agent start` first validates `AGENT_MASTER_KEY`, opens/migrates SQLite,
  prunes expired storage, and deletes transient event-overflow rows. A missing
  or invalid master key fails before either listener binds.
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
- Base: a fresh database has no `runtime` setting, so the Agent binds remote
  health on `127.0.0.1:43182` and local administration on
  `127.0.0.1:43183`.
- Bad: registering local-admin routes on the remote app, accepting a mutation
  with only a CSRF header but no matching origin, or deleting an unmatched
  control-state file during startup failure.

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
- Control-state tests prove a runtime cannot remove a file whose token belongs
  to another runtime.

### 7. Wrong vs Correct

#### Wrong

```ts
const app = await buildRemoteApiApp();
app.register(localAdminRoutes);
await app.listen({ host: "0.0.0.0", port: 43182 });
```

This makes a tunnel or a Tailscale binding expose administration endpoints.

#### Correct

```ts
const remoteApp = await buildRemoteApiApp();
const localAdminApp = await buildLocalAdminApp(options);

await localAdminApp.listen({ host: "127.0.0.1", port: 43183 });
await remoteApp.listen({ host: remoteHost, port: remotePort });
```

The process runtime owns both sockets, and only the local-admin app can mount
local administration routes.
