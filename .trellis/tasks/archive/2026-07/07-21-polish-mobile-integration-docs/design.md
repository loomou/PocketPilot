# Design: Polish mobile integration docs for parity

## Boundaries

- **In:** narrative integration guides for mobile authors.
- **Out:** backend code changes, OpenAPI schema redesign, Claude SDK type encyclopedia rewrite.
- **Sources of truth (priority):**
  1. Current runtime code + tests
  2. `.trellis/spec/backend/*` contracts (agent-provider, codex-app-server, error-handling, api-documentation, task-runtime)
  3. Existing accurate sections in current guides (reuse wording when still correct)

## Architecture of the doc set

```text
mobile-integration-guide (shared)
  ├── auth / workspace / tasks
  ├── discovery + readiness
  ├── shared REST inventory
  ├── Agent WS vs events WS
  ├── differences matrix + capability checklist
  └── links → codex-mobile-integration-guide
            → claude-sdk-message-types

codex-mobile-integration-guide (Codex deep dive)
  ├── Codex REST confirm/lifecycle rules
  ├── native actions + status catalogs
  ├── agent.checkpoint reconnect
  └── differences vs Claude

codex-app-server-integration (protocol/lifecycle)
  └── light cross-links only
```

## Content contracts

### Must not invent

- Endpoints, query names, capability keys, error codes, confirm rules, notification names.

### Must keep closed shapes

Document only closed capability objects already sanitized:

- `attachments: boolean`
- `nativeActions: { review, rename, compact }`
- `statusCatalogs: { account, rateLimits, skills, hooks, mcpServers }`
- `threadManagement: { archive, delete, fork, includeArchived, search, unarchive }`
- `historyFilters: { includeSystemMessages }`
- `historyPagination`

### Reconnect honesty

- Codex: first Agent frame may be `agent.checkpoint`; later frames native.
- Subscribe-time only: checkpoint may lag mid-turn; full-window fallback still correct.
- Claude: no `agent.checkpoint` in this surface.

### Confirm honesty

- Archive/delete require `confirm: true`.
- Archive does **not** auto-close bound tasks.
- Delete closes bound non-terminal task only after native success.

## Bilingual process

1. Author English structure first for each guide family.
2. Mirror section order and facts into zh-CN (not machine-tone dump; keep existing zh style where present).
3. Diff check: every H2 in en has a counterpart in zh for that file pair.

## Migration / compatibility

- External bookmarks to old section numbers may break; add a short “Guide map” near the top listing new sections.
- Prefer stable conceptual anchors (`## Conversation REST`, `## Reconnect`) over fragile numbering-only references.

## Risks

- Drift between en/zh → mitigate with implement checklist per section.
- Over-documenting unreviewed safety notifications → leave as “not allowlisted”.
- Duplicating OpenAPI field dumps → link OpenAPI/Swagger instead of copying every schema.

## Rollback

- Git revert of the four markdown files (+ any light app-server cross-link edits). No runtime impact.
