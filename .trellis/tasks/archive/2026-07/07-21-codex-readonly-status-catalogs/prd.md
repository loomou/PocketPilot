# Implement Codex read-only status and catalogs

## Goal

Give mobile Codex tasks a trustworthy read-only readiness and configuration surface: account/quota readiness, skills/hooks/MCP status catalogs, and only the reviewed status notifications needed to keep that surface current—without exposing credentials, login/logout, writes, or arbitrary local paths.

## Background

- Parent audit: `.trellis/tasks/07-20-claude-code-parity-audit`
- Previous P1 child completed: `07-21-codex-native-action-capabilities`
- Codex Agent WebSocket currently allowlists only turn/history/catalog methods:
  `model/list`, `collaborationMode/list`, `permissionProfile/list`,
  `thread/read`, `thread/turns/list`, `thread/items/list`, plus turn and the
  three native actions. Status/catalog methods are denied today.
- Local Codex `0.144.6` schema confirms the target methods and notifications.
  Research dump:
  `.trellis/tasks/07-21-codex-readonly-status-catalogs/research/codex-app-server.schema.json`
- Sensitive sibling methods exist and must remain denied: `account/login/*`,
  `account/logout`, token refresh/usage writes, `skills/config/write`,
  `skills/extraRoots/set`, marketplace install, MCP tool execution/elicitation.
- Native frames remain the transport; PocketPilot still remaps request IDs and
  owns allowlisting, capacity, and workspace authorization.
- Task-owned responses currently publish to the journal as native frames with
  only request-id remapping. There is no response-projection path yet.
  Process-level notifications without `threadId` are currently dropped because
  delivery routing requires a thread-bound runtime.

## Confirmed facts

- `account/read` params may include `refreshToken: true`, which triggers managed
  auth refresh and must not be allowed from remote.
- `account/read` response can include ChatGPT `email` and account type/plan.
- `account/rateLimits/read` is params-null and returns quota/credits snapshots.
- `skills/list` and `hooks/list` accept optional `cwds[]` and return entries that
  include absolute local paths (`cwd`, `path`, `sourcePath`, icon paths, error
  `path`).
- `mcpServerStatus/list` supports pagination (`cursor`/`limit`), optional
  `threadId`, and detail mode (`full` | `toolsAndAuthOnly`).
- `skills/changed`, `account/updated`, and `account/rateLimits/updated` are
  process-level notifications without `threadId`.
- `hook/started` and `hook/completed` are thread-scoped and embed
  `HookRunSummary` with required `sourcePath`.
- Existing remote read methods are P3 via `submitRead` +
  `assertReadable` (no capacity reservation).
- Path authorization already exists for absolute-path params
  (`collectAbsolutePaths`), but there is no general remote response redaction.
- Capability discovery currently exposes closed `nativeActions` and
  `attachments: false`; no status/catalog capability descriptors exist yet.

## Decisions

- **D1 notifications (2026-07-21):** Forward only catalog/readiness
  notifications:
  - `skills/changed`
  - `account/updated`
  - `account/rateLimits/updated`
  - `mcpServer/startupStatus/updated` (native schema name; earlier informal label
    was `mcpServerStatus/updated`)
  - `hook/started`
  - `hook/completed`
  - Deferred: login-completion, guardian/auto-approval reviews, moderation
    metadata, safety buffering.
- **D2 redaction (2026-07-21):** Omit absolute path fields and project account
  readiness through a closed shape. Do not basename/hash or rewrite to
  workspace-relative paths.
- **D3 capability discovery (2026-07-21):** Add a closed `statusCatalogs`
  capability descriptor for feature detection, analogous to `nativeActions`.

## Requirements

### R1 — Read-only method allowlist
- Allow only:
  - `account/read`
  - `account/rateLimits/read`
  - `skills/list`
  - `hooks/list`
  - `mcpServerStatus/list`
- Keep all account login/logout/token/write, skills write/extraRoots, plugin
  install, and MCP tool-execution methods denied.

### R2 — Safe account/quota readiness
- Expose readiness and quota without credentials, tokens, or email.
- Reject remote `refreshToken: true` on `account/read`.
- Project `account/read` through a closed readiness shape rather than
  passthrough of the native account object.

### R3 — Catalog surfaces
- Support skills, hooks, and MCP status listing for the current authorized task
  workspace.
- Do not accept arbitrary remote `cwds` outside the authorized workspace.
- Default catalog roots to the task workspace when the client omits `cwds`.
- Do not invent REST mutation/catalog routes; keep execution on the Agent
  WebSocket.

### R4 — Path and secret hygiene
- Omit absolute local paths and path-bearing fields from remote-visible
  responses and the D1 notifications.
- Strip credentials, tokens, emails, and privileged config.
- Preserve enough stable identity for mobile UI (names, enabled flags, status
  enums, tool names, plan/quota fields) without leaking host filesystem layout.

### R5 — Reviewed status notifications
- Forward only the D1 notification set after hygiene.
- Process-level notifications without `threadId` fan out to non-terminal Codex
  tasks; thread-scoped hook notifications remain thread-bound.
- Do not forward login-completion, elicitation, guardian/moderation, or other
  privileged server requests/notifications.

### R6 — Runtime and capacity
- Catalog and status reads use the existing P3 lane: no capacity reservation,
  no idle requirement, recheck task/workspace authorization around forward.
- Preserve current turn lifecycle and native-action behavior unchanged.

### R7 — Discovery and docs
- Advertise the closed `statusCatalogs` surface through provider capability
  metadata, OpenAPI, and mobile/App Server docs.
- Update contract tests so unavailable methods remain unadvertised.

## Acceptance Criteria

- [ ] AC1: The five reviewed read methods are allowlisted and validated; sibling
      privileged methods remain denied with `403 CODEX_REQUEST_NOT_ALLOWED`.
- [ ] AC2: `account/read` never returns email/tokens/credentials and rejects
      remote token refresh; readiness uses a closed projection.
- [ ] AC3: `account/rateLimits/read` works as a P3 read and returns quota
      readiness without secrets.
- [ ] AC4: `skills/list`, `hooks/list`, and `mcpServerStatus/list` work for the
      authorized workspace and reject unauthorized path roots.
- [ ] AC5: Remote-visible catalog/status payloads omit absolute host paths and
      credentials.
- [ ] AC6: Only the D1 notifications are forwarded after hygiene; process-level
      ones fan out safely; privileged notifications stay blocked.
- [ ] AC7: Capability discovery publishes closed `statusCatalogs` for Codex and
      empty/absent equivalent for providers without the surface.
- [ ] AC8: Focused protocol/adapter/docs tests cover allowlist, projection,
      workspace binding, fan-out, and P3 behavior; typecheck/lint/tests pass.
- [ ] AC9: Mobile and App Server docs describe the safe read-only surface and
      explicitly exclude login/write/MCP execution.

## Out of scope

- Account login/logout, token refresh, usage writes, rate-limit credit consume
- Skills/hooks config writes, extra roots, marketplace/plugin install
- MCP tool calls, resource reads, elicitation responses
- Turn-scoped safety notifications (guardian, auto-approval reviews, moderation,
  safety buffering)
- Thread fork/archive/delete/search/rollback
- Attachment upload/reference
- Provider availability probe redesign and live destructive coverage expansion
- Replay checkpoint optimization
- Basename/hash path projection or workspace-relative rewrite

## Technical Notes

- Schema research lives under the task `research/` directory and should be
  referenced by implement/check manifests.
- Response projection requires tracking pending remote request methods so
  result frames can be rewritten before journal publish.
- Hook command strings may embed host paths; omit `command` from remote-visible
  hook metadata in this batch.
