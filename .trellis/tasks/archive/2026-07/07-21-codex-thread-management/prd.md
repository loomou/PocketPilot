# Implement Codex thread management

## Goal

Let mobile Codex clients manage conversation lifecycle safely over provider REST: search/filter threads, fork into a new conversation/task, and archive/unarchive/delete authorized threads—using native thread IDs, explicit destructive confirmation, and coherent PocketPilot task binding—without path leakage or deprecated rollback.

## Background

- Parent audit: `.trellis/tasks/07-20-claude-code-parity-audit`
- Completed P1 children:
  - `07-21-codex-native-action-capabilities`
  - `07-21-codex-readonly-status-catalogs`
- Today PocketPilot REST owns Codex conversation lifecycle:
  - list / read history / start / attach
  - close task does **not** archive or delete the native thread
- Agent WebSocket already owns turn/native-actions/status-catalogs, not thread lifecycle mutations.
- Local Codex `0.144.6` schema confirms:
  - `thread/fork` (prefer `threadId`; path form must stay remote-denied)
  - `thread/archive`
  - `thread/unarchive`
  - `thread/delete`
  - `thread/rollback` is **DEPRECATED** and excluded
- There is no separate `thread/search`; search is `thread/list.searchTerm`.
- Archived filtering is `thread/list.archived`.
- Common provider adapter surface currently exposes only
  list/read/create/attach. Provider REST routes match that surface.

## Confirmed facts

- `listConversations` already calls `thread/list` with fixed `sourceKinds` and
  post-filters by authorized workspace, but does not pass `searchTerm` or
  `archived`.
- Conversation mutations use client `operationId` + `workspaceRiskAccepted` and
  return `TaskOperationResult`.
- Task actions currently include `created` / `attached` / `closed` / etc.;
  fork/archive/delete will need reviewed action values or an equivalent closed
  response shape.
- Close task remains separate from native archive/delete.
- Fork responses include absolute `cwd` and instruction source paths that must
  not leak remotely.

## Decisions

- **D1 operations (2026-07-21):** Include list filters (`searchTerm`,
  `archived`), `thread/fork`, `thread/archive`, `thread/unarchive`,
  `thread/delete`. Exclude deprecated `thread/rollback` and path-based fork.
- **D2 transport (2026-07-21):** Conversation lifecycle stays on provider REST,
  extending the existing list/create/attach ownership. Agent WebSocket is not
  the primary surface for these mutations.
- **D3 task side effects (2026-07-21):**
  - Fork creates/reuses a PocketPilot task for the new thread and returns task
    transport metadata (same family as create/attach).
  - Archive / unarchive do **not** auto-close tasks.
  - Delete of a currently bound non-terminal task thread closes that PocketPilot
    task after successful native delete.
  - Unbound threads can still be managed by `nativeConversationId` without an
    existing task.
  - Destructive REST ops require an explicit confirm flag in addition to
    `operationId` / workspace authorization.

## Requirements

### R1 — Closed capability discovery
- Publish a closed `threadManagement` capability descriptor for implemented
  operations only.
- Claude/fake providers publish an empty object until they implement a reviewed
  surface.

### R2 — List filters / search
- Extend conversation list with optional `searchTerm` and `archived`.
- Keep workspace authorization and source-kind filtering.
- Continue projecting list rows without leaking unauthorized workspace threads.

### R3 — Fork
- REST fork of an authorized thread by `nativeConversationId` / thread id.
- Call native `thread/fork` with `threadId` only; reject path-based fork.
- Create/reuse a PocketPilot task for the forked thread and return task
  transport metadata.
- Project the response so absolute host paths are omitted.

### R4 — Archive / unarchive / delete
- REST archive, unarchive, and delete for authorized threads.
- Require explicit `confirm: true` for archive and delete.
- Unarchive requires authorization but not destructive confirm.
- If delete targets a currently bound non-terminal task thread, close that task
  after native delete succeeds.
- Archive/unarchive leave existing tasks non-terminal unless the client closes
  them separately.

### R5 — Authorization and hygiene
- Every mutation re-authorizes the workspace and verifies the target thread is
  inside that workspace before native forward.
- Deny unauthorized threads, path-based fork, and unreviewed methods.
- Omit absolute paths/secrets from remote-visible responses.

### R6 — Docs and tests
- Update mobile/App Server docs, OpenAPI/provider schemas, and focused tests.
- Explicitly document that task close ≠ native archive/delete, and that
  rollback remains unavailable.

## Acceptance Criteria

- [ ] AC1: Conversation list supports `searchTerm` and `archived` under an
      authorized workspace.
- [ ] AC2: Forking an authorized thread creates/reuses a PocketPilot task for
      the new native thread and returns usable task transport metadata.
- [ ] AC3: Archive/unarchive/delete work for authorized threads; archive/delete
      require explicit confirm.
- [ ] AC4: Deleting the currently bound non-terminal task thread closes that
      PocketPilot task after native delete; archive does not auto-close.
- [ ] AC5: Path-based fork and unauthorized thread management are rejected.
- [ ] AC6: Remote-visible responses omit absolute host paths/secrets.
- [ ] AC7: Capability discovery advertises closed `threadManagement` matching
      implemented ops only.
- [ ] AC8: Focused tests, typecheck, lint, and docs/OpenAPI coverage pass.

## Out of scope

- Mobile attachments
- Account login/write, skills/hooks writes, MCP tool execution
- Agent WebSocket-only lifecycle mutations for non-current threads
- Deprecated `thread/rollback`
- Path-based fork
- Broad thread metadata editing
- Provider readiness probe redesign
- Replay checkpoint
- File-system revert of agent edits

## Technical Notes

- Prefer extending the common provider adapter/runtime manager surface so Claude
  can no-op/deny cleanly rather than hardcoding `providerId === "codex"` in
  routes.
- Reuse existing operation idempotency (`deviceId` + `operationId`) for
  mutations.
- Schema research can reuse the archived Codex App Server schema dump from the
  status-catalogs task or regenerate under this task's `research/`.
