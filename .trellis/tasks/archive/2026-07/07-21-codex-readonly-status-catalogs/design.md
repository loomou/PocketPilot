# Design: Codex read-only status and catalogs

## Summary

Extend the existing Codex Agent WebSocket allowlist and delivery path so mobile
clients can read account/quota readiness plus skills/hooks/MCP catalogs, and
receive only the reviewed status notifications that keep those surfaces current.
All privileged sibling methods stay denied. Remote-visible payloads use closed
projections that omit absolute paths, email, tokens, and credentials. Capability
discovery advertises a closed `statusCatalogs` descriptor.

## Architecture and boundaries

```
Mobile Agent WS
  -> CodexProviderAdapter.submit
      -> submitRead (P3 / assertReadable) for status catalog methods
      -> prepareTaskRequest + param validation / cwd binding
      -> CodexAppServerBridge.forward (request-id remap only)
  <- bridge delivery
      -> response projection by pending method
      -> notification filter + hygiene
      -> process-level fan-out OR thread-bound publish
      -> task journal / remote stream
```

Boundaries:

- **Protocol** (`src/codex-app-server/protocol.ts`): closed method lists,
  notification allowlist, param validators, projection helpers.
- **Adapter** (`src/codex-app-server/provider-adapter.ts`): P3 routing, cwd
  binding, pending-method tracking, response/notification rewrite, fan-out.
- **Capabilities** (`src/agent-providers/types.ts`, `registry.ts`, Claude
  adapter, provider routes/OpenAPI): closed `statusCatalogs` sanitizer.
- **Docs/tests**: mobile + App Server guides, protocol/adapter/registry/route
  coverage.

No new REST mutation routes. No PocketPilot action envelopes. Native JSON-RPC
frame shape remains; only request IDs and reviewed field projections change.

## Contracts

### Client request methods (new allowlist, P3)

| Method | Params policy | Response projection |
|---|---|---|
| `account/read` | Allow `{}` or omit/false `refreshToken`. Reject `refreshToken: true`. | Closed readiness object |
| `account/rateLimits/read` | Params must be empty/null-compatible | Passthrough numeric quota snapshot after secret scrub |
| `skills/list` | Optional `cwds[]`; authorize every entry under task workspace; default to `[workspace]` when omitted | Omit path-bearing fields |
| `hooks/list` | Same cwd policy as skills | Omit path-bearing fields and `command` |
| `mcpServerStatus/list` | Optional `cursor`/`limit`/`detail`; optional `threadId` must equal current task thread or be injected | Keep names/status/tool names; omit path-like resource URIs if absolute |

Denied examples remain denied with `403 CODEX_REQUEST_NOT_ALLOWED`:
`account/login/*`, `account/logout`, `account/chatgptAuthTokens/refresh`,
`skills/config/write`, `skills/extraRoots/set`, marketplace/plugin install,
MCP tool execution/elicitation.

### Closed account readiness projection

Rewrite `account/read` results to:

```ts
{
  requiresOpenaiAuth: boolean,
  account:
    | null
    | { type: "apiKey" }
    | { type: "chatgpt"; planType: string | null }
    | { type: "amazonBedrock"; credentialSource?: string }
}
```

Never include `email`, tokens, refresh material, or raw account passthrough.

### Catalog projection rules

- Drop absolute path fields: `cwd`, `path`, `sourcePath`, path-bearing error
  fields, absolute icon paths.
- Drop hook `command` (may embed host paths).
- Keep stable UI fields: names, keys, enabled, scopes/sources as enums, status
  enums, descriptions, tool names, plan/quota numbers, authMode/planType.
- Preserve array/object structure so clients still receive native-looking
  method results, just with sensitive fields omitted.

### Notifications (D1)

| Method | Routing | Hygiene |
|---|---|---|
| `skills/changed` | Process-level fan-out to non-terminal Codex tasks | Empty params OK |
| `account/updated` | Process-level fan-out | Keep `authMode`/`planType` only |
| `account/rateLimits/updated` | Process-level fan-out | Secret scrub only |
| `mcpServer/startupStatus/updated` | Process-level fan-out unless a thread id is present | Same as MCP list projection |
| `hook/started` | Thread-bound | Omit `sourcePath`/`command` from summary |
| `hook/completed` | Thread-bound | Same |

Process-level fan-out publishes the same sanitized frame to every non-terminal
Codex runtime journal. Thread-bound notifications continue to require a matching
`threadId`.

### Capability discovery

Extend `AgentProviderCapabilities` with closed:

```ts
statusCatalogs?: {
  account: { method: "account/read"; refreshToken: false }
  rateLimits: { method: "account/rateLimits/read" }
  skills: { method: "skills/list"; notifications: ["skills/changed"] }
  hooks: {
    method: "hooks/list"
    notifications: ["hook/started", "hook/completed"]
  }
  mcpStatus: {
    method: "mcpServerStatus/list"
    notifications: ["mcpServer/startupStatus/updated"]
  }
  accountNotifications: ["account/updated", "account/rateLimits/updated"]
}
```

Sanitizer admits only reviewed keys/fields. Claude and fake providers publish an
empty object or omit only if existing optional style requires empty object for
parity—prefer empty object for stable schema like `nativeActions`.

## Data flow details

### Request path

1. `parseCodexClientFrame` admits the five methods into
   `codexClientRequestMethods` and `codexReadClientRequestMethods`.
2. Adapter `submit` routes them through existing `submitRead`.
3. Before forward:
   - reject unauthorized methods/params
   - for skills/hooks: normalize `cwds` to authorized workspace roots
   - for MCP list: bind/inject current `threadId` when present/required
   - record pending remote request metadata
     `{ clientRequestId, method, taskId }` keyed by bridge pending key /
     client request key so the response can be projected
4. Forward native frame with remapped request id only.

### Response path

Current code publishes task-owned response frames unchanged. Change to:

1. On response/error delivery for a task-owned pending request, look up the
   pending method.
2. If the method is one of the five status/catalog methods and the frame has
   `result`, replace `result` with the projected object.
3. Publish the rewritten frame to the task journal.
4. Clear pending metadata. Errors pass through without inventing success
   payloads.

Pending metadata must be generation-aware and cleared on interrupt/close the
same way other pending maps are cleared.

### Notification path

1. Expand `codexForwardedNotificationMethods` with the D1 set only.
2. If notification has a matching task `threadId`, publish sanitized frame to
   that runtime.
3. If notification is process-level (no thread id) and in the process-level D1
   set, fan out sanitized copies to all non-terminal Codex runtimes.
4. Drop everything else.

## Compatibility

- Existing turn/history/native-action behavior remains unchanged.
- Clients that already ignore unknown notifications continue to work.
- Clients that previously received `CODEX_REQUEST_NOT_ALLOWED` for the five
  methods will start succeeding with projected results.
- Docs and OpenAPI must advertise `statusCatalogs` so feature detection does
  not hardcode provider ids.

## Trade-offs

1. **Response rewrite vs pure passthrough**
   - Pure passthrough would leak email/paths.
   - Rewrite keeps native method names while enforcing remote safety.
2. **Omit paths vs relative rewrite**
   - Omit is simpler and matches D2 risk posture.
   - Loses host-side debugging detail on mobile (accepted).
3. **Process-level fan-out**
   - Required because several status notifications lack `threadId`.
   - Slightly noisier multi-task sessions; still safer than dropping readiness
     updates.

## Rollback / operational notes

- Feature is allowlist-gated. Emergency rollback is removing the five methods
  and D1 notifications from the protocol lists and dropping `statusCatalogs`
  from Codex capabilities.
- No persistence/schema migration.
- No destructive live tests required for merge; optional live reads may be
  added later with non-mutating cases only.

## Test matrix (design-level)

- Protocol: method allow/deny, refreshToken rejection, cwd validation helpers,
  projection unit tests for account/skills/hooks/mcp/hook notifications.
- Adapter: P3 path, unauthorized cwd rejection, response rewrite before journal,
  process-level fan-out, thread-bound hooks, pending cleanup on interrupt.
- Registry/routes/OpenAPI: closed `statusCatalogs` shape; Claude empty object.
- Docs: EN/ZH mobile + App Server guides mention safe surface and exclusions.
