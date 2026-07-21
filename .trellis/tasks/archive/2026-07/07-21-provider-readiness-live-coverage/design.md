# Design: Provider readiness and live coverage

## Summary

Add a bounded, cached provider readiness probe used by discovery/capabilities
routes, and expand optional Codex live coverage for the landed provider surfaces.
Readiness stays inside the existing status enum and reason-code model. Live
mutations only touch disposable forked threads with cleanup.

## Architecture and boundaries

```
GET /v1/providers
GET /v1/providers/{id}/capabilities
  -> AgentRuntimeManager / registry
      -> adapter.refreshReadiness({ force? })  // if stale
      -> sanitizeDescriptor(adapter.descriptor)

Optional live harness
  -> real Codex command + caller workspace
  -> provider REST + Agent WS adapter paths
  -> cleanup disposable forks
```

Boundaries:

- **Adapters** own provider-specific probe mechanics and update their descriptor
  status/reasonCode/protocolVersion.
- **Registry/runtime manager** owns cache freshness policy and sanitized
  projection.
- **Routes** trigger refresh before returning discovery/capabilities.
- **Live tests** remain opt-in scripts; unit tests fake probes.

## Readiness contracts

### Status mapping

| Condition | Status | Reason code (stable) |
|---|---|---|
| Command/package missing | `not_installed` | `CODEX_COMMAND_NOT_FOUND` / `CLAUDE_SDK_NOT_AVAILABLE` |
| Present but unsupported version/protocol | `unsupported_version` | `CODEX_APP_SERVER_VERSION_UNSUPPORTED` / `CLAUDE_SDK_VERSION_UNSUPPORTED` |
| Probe timed out or failed without version proof | `unhealthy` | `CODEX_APP_SERVER_PROBE_FAILED` / `CLAUDE_SDK_PROBE_FAILED` |
| Probe succeeded | `available` | omit reasonCode |
| Locally disabled by config (if already present) | `disabled` | existing/local-admin reason |

Never expose absolute executable paths, env dumps, raw stderr, or stack traces
in descriptors.

### Probe mechanics

#### Codex
1. Resolve configured command (`POCKETPILOT_CODEX_COMMAND` or default `codex`).
2. If command not available → `not_installed`.
3. Run a timeboxed initialize probe:
   - Prefer a dedicated short-lived probe path that starts App Server,
     `initialize`s, checks `isSupportedCodexVersion`, then cleanly closes.
   - Do not leave a probe child alive after the check.
   - If a long-lived bridge is already healthy and recent, adapters may reuse
     that known-good state instead of spawning a second process.
4. Unsupported version → `unsupported_version`.
5. Timeout/unexpected failure → `unhealthy`.
6. Success → `available`, set `protocolVersion` to the reviewed protocol marker
   and optionally retain non-secret CLI version only if already part of the
   reviewed projection model.

#### Claude
1. Cheap package/protocol readiness:
   - Confirm the reviewed SDK protocol constant/module is loadable.
   - If the package cannot be resolved → `not_installed`.
   - If a future pinned version gate fails → `unsupported_version`.
2. Do **not** start a full Claude agent session for readiness.
3. Success → `available` with existing protocolVersion string.

### Cache / refresh policy

- Each adapter keeps:
  - `status` / `reasonCode` / `protocolVersion`
  - `readinessCheckedAt`
  - in-flight probe promise (single-flight)
- Default TTL: short (e.g. 30–60 seconds). Exact value should be a named
  constant.
- Refresh triggers:
  - `GET /v1/providers`
  - `GET /v1/providers/{providerId}/capabilities`
  - optional force refresh only if an existing local-admin/debug path already
    fits; do not invent a public remote force endpoint in this batch
- Non-discovery request paths do not need to re-probe on every call.
- `requireAvailable` continues to use the latest descriptor status after any
  refresh performed by the calling path.

### API surface changes

Prefer provider-neutral adapter hook:

```ts
interface AgentProviderAdapter {
  readonly descriptor: AgentProviderDescriptor;
  refreshReadiness?(options?: { force?: boolean }): Promise<void>;
  // existing methods...
}
```

Registry/runtime manager:

```ts
await registry.refreshDescriptors({ force?: boolean });
registry.descriptors(); // sanitized current snapshot
```

Or runtime manager methods used by routes:

```ts
await agentRuntimeManager.listProviders();
await agentRuntimeManager.getCapabilities(providerId);
```

Routes become async refresh-before-return. Descriptor sanitization remains the
only remote projection path.

## Live coverage design

### Harness constraints
- Opt-in via existing `pnpm test:codex:live` (and Claude live if needed).
- Require caller-provided absolute workspace env var(s).
- Skip by default in ordinary `pnpm test`.
- No hardcoded developer machine paths.
- Mutating cases create disposable resources and clean them up in `finally`.

### Codex live scenarios (D2)

Keep existing bridge smoke:
1. initialize + catalogs
2. turn start/stream/history
3. interrupt

Add provider-level coverage (prefer adapter/runtime or remote API fixture over
raw bridge-only when testing PocketPilot surfaces):

4. **Readiness discovery**
   - `GET /v1/providers` and/or capabilities shows Codex `available` (or
     expected unavailable status in negative fixtures)
5. **Status catalogs over Agent WS**
   - after create/attach task:
     - `account/read` (no refreshToken)
     - `account/rateLimits/read`
     - `skills/list`
     - `hooks/list`
     - `mcpServerStatus/list`
   - assert path/email/token fields are absent from projected results
6. **Rename**
   - `thread/name/set` for current task thread
7. **List filters**
   - REST list with `searchTerm` and/or `includeArchived`
8. **Fork + cleanup**
   - REST fork of a disposable thread created by the test
   - archive and/or delete the **forked** conversation with `confirm: true`
   - never archive/delete pre-existing user threads

### Explicitly excluded live cases
- detached review
- inline review (this batch)
- account login/logout
- skills/hooks writes
- MCP tool execution
- path-based fork
- rollback

## Compatibility

- Existing unavailable-provider behavior remains.
- Clients that only check `status === "available"` continue to work.
- Live suite remains optional; CI default path unchanged.
- No DB migration.

## Trade-offs

1. **Short-lived Codex initialize probe vs command-exists only**
   - Higher confidence for unsupported versions; more process cost.
   - Mitigated by TTL + single-flight + reuse of known-good bridge state.
2. **Refresh on discovery only vs every request**
   - Discovery refresh is enough for mobile feature detection without taxing
     turn traffic.
3. **Provider-level live tests vs bridge-only**
   - Provider-level tests catch projection/auth/task side effects that bridge
     smoke misses; they are heavier and need cleanup design.

## Rollback

- Readiness: fall back to startup command-exists / hardcoded available by
  removing refresh hooks.
- Live: new cases are opt-in; remove or skip if flaky.
- No persistent schema change.

## Test matrix

### Unit / integration
- Codex command missing → `not_installed`
- Codex unsupported version → `unsupported_version`
- Codex probe timeout/failure → `unhealthy`
- Codex success → `available`
- Claude package/protocol success and failure mappings
- Cache TTL / single-flight (second concurrent refresh does not double-probe)
- Discovery/capabilities routes return refreshed sanitized descriptors
- No path/secret leakage in descriptors

### Live (opt-in)
- Existing smoke remains green
- New D2 scenarios pass with cleanup
- Ordinary `pnpm test` still skips live files without env
