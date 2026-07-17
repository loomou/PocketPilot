# Local Workspace Authorization Management

## Goal

Replace the raw `workspaceRoots` text editor with a computer-local authorized
directory management experience, and define one explicit runtime operation
priority model for authorization revocation, close, interrupt, ordinary SDK
input, controls, approvals, and background reads. The computer owner chooses
which directories PocketPilot may expose; remote/mobile clients can only list
and use that allowlist and can never add arbitrary paths.

## Background

- The loopback-only React administration page currently renders
  `workspaceRoots` as a newline-separated textarea in
  `apps/local-admin/src/features/administration/administration-page.tsx`.
- `PUT /admin/configuration/tasks` currently replaces the complete task policy
  `{ concurrentTaskCapacity, workspaceRoots }` after Zod validation, but does
  not validate that roots exist or canonicalize them when saved.
- Task/session operations later canonicalize the requested workspace and each
  configured root before authorization. `GET /v1/workspaces` returns the saved
  allowlist to an authenticated mobile device.
- Local administration is bound to loopback, protected by exact-origin and
  CSRF checks, and is never registered on the remote listener.
- A normal browser directory input or File System Access handle does not give
  the Node Agent a stable absolute filesystem path it can later pass to the
  Claude SDK. A real absolute-path selection therefore needs either a native
  picker opened by the local Agent or a local-only server filesystem browser.
- PocketPilot is currently a foreground-controlled Windows Agent; its release
  gate is the Windows packaged-install smoke test.
- Runtime operations currently use different mechanisms rather than one
  priority abstraction: close and interrupt bypass the per-task lane; SDK
  input, activation, approval resolution, and model/mode/effort controls use
  the per-task lane; capacity, attachment, and history use separate lanes.
- `SDKUserMessage.priority` is forwarded unchanged to Claude and is not a
  PocketPilot scheduler.
- A bypassing interrupt/close can race with ordinary work already queued on the
  per-task lane. There is no shared operation generation that explicitly
  invalidates every pre-interrupt/pre-close queued operation.

## Requirements

### Computer-owned authorization

- Remove the user-facing raw `Workspace roots` textarea from the local
  administration page.
- Show an explicit **Authorized directories** list with one canonical local
  path per row, an **Add directory** action, and a per-row **Remove** action.
- Only the loopback local administration surface may add or remove authorized
  directories. Do not add any remote/mobile mutation route.
- Keep `workspaceRoots` as the internal persisted task-policy field and the
  source used by existing workspace/session authorization. This is a UX and
  local-management contract change, not a weakening or replacement of the
  authorization boundary.
- `GET /v1/workspaces` remains read-only and returns only directories the
  computer owner has saved.
- Add/Remove actions persist immediately through dedicated local-only routes
  and return the latest complete authorized-root set. They are not staged
  behind the existing **Save configuration** action.
- Render authorization management as a separate **Authorized directories**
  security section rather than a field inside **Runtime and task policy**. The
  latter retains listener/mobile/capacity fields and its Save action; the new
  section owns its own list, affected-runtime counts, Add, Remove, and
  confirmation UI.
- The ordinary task-policy save route must no longer accept `workspaceRoots`
  as user input. It updates concurrent task capacity only; dedicated picker
  and removal operations are the sole workspace-root mutation owners.

### Directory selection and validation

- The **Add directory** action must ask the local Agent to open the native
  Windows folder picker. Do not substitute a browser directory upload input or
  add a server filesystem-navigation API in the MVP.
- The selected value must be an existing directory on the Agent computer and
  must be converted to its canonical absolute path before it is displayed or
  persisted.
- Reject files, missing/inaccessible directories, empty values, and picker
  results that cannot be canonicalized. Return a stable local-admin error
  without exposing raw subprocess/framework exception text.
- Treat canonical duplicates as one authorization entry, including Windows
  path case differences and symlink/junction aliases.
- Preserve pre-existing roots that cannot currently be resolved as visibly
  unavailable/removable entries rather than silently deleting or broadening
  them. An unavailable root cannot authorize new work; resolvable legacy roots
  join the same canonical/minimal normalization as newly selected roots.
- Persist a minimal non-overlapping root set. If an existing parent already
  authorizes the selected child, make the add a deterministic no-change result
  that identifies the covering root. If a newly selected parent covers
  existing child roots, persist the parent and remove those redundant child
  rows in the same update.
- Removing a parent does not restore child roots that were previously removed
  as redundant. The computer owner must explicitly add any desired child root
  again.
- Preserve multiple independent authorized roots that do not contain one
  another.
- Adding a parent that replaces covered child entries is an authorization
  expansion, not a revocation. Existing tasks under those children continue
  because effective access was never lost.
- Cancelling directory selection is a normal no-change outcome, not an error
  and not an empty root.
- Allow a volume root such as `C:\` or `L:\` only after a second explicit
  high-risk confirmation explaining that every directory on that volume
  becomes authorized. Never add a volume root silently.
- A browser follow-up confirmation must consume a short-lived, single-use
  selection reference created by the native picker. It must not turn into an
  API that accepts an arbitrary caller-supplied filesystem path.

### Removal and runtime behavior

- Removing a root prevents new workspace/session discovery, history,
  attachment, and task creation under that root through the existing policy
  checks.
- Removing a root is an approved P0 security revocation. Before the local API
  returns success, reject new work for that root, invalidate queued lower-tier
  operations, cancel pending approvals, interrupt and close every affected
  live Query, and terminalize affected idle/executing/approval/interrupted
  tasks. Do not wait for a lower-tier per-task lane before applying rejection.
- The local page must warn how many non-terminal runtimes will be stopped and
  require explicit confirmation before removing the root.
- The Agent must reject a stale removal confirmation when either the root-set
  revision or affected non-terminal runtime count changed, refresh the list,
  and require a new confirmation before stopping a different runtime set.
- P0 terminalization closes every affected raw task SDK WebSocket immediately
  with the existing task-session-unavailable close contract. The independent
  control WebSocket remains connected and can deliver the terminal task state.
- Removal must not delete or modify Claude projects, settings, credentials, or
  transcripts.
- Reauthorizing the directory does not resurrect a terminal task handle. The
  unchanged Claude Session remains discoverable and can be attached through a
  new internal runtime.
- Directory-list changes should not require a listener restart. Listener host,
  port, and mobile base URL retain their existing next-start behavior.
- Directory Add/Remove must not save unrelated unsaved runtime or concurrent
  capacity form edits.

### Security and privacy

- The directory picker/management API must remain loopback-only and require
  the existing exact-origin plus CSRF protection for every state-changing
  request.
- Do not expose drive listings, arbitrary filesystem enumeration, environment
  variables, file contents, or directory contents to the remote API.
- Audit only metadata needed to explain local authorization changes; never log
  file contents or scan the selected directory.
- Do not add a native dependency that weakens the deterministic Windows
  packaged-install flow without an explicit reviewed need.

### Runtime operation priority

- Define priority through observable behavior: whether an operation bypasses
  ordinary ordering, cancels current SDK work, invalidates queued lower-tier
  operations, and what task state remains afterward.
- Preserve `SDKUserMessage.priority` (`now`, `next`, `later`) unchanged and let
  Claude Code own its meaning. Do not reinterpret those values as PocketPilot
  runtime-control priority.
- Approved priority tiers:
  - **P0 terminal/security revocation**: Agent shutdown, explicit task close,
    and removal of an authorized root. They reject new
    input/control immediately, cancel pending approval, invalidate queued
    lower-tier operations, interrupt and close the live Query, and leave the
    task terminal/non-resumable through the old handle.
  - **P1 turn preemption**: explicit task interrupt. It invalidates older
    queued lower-tier operations, cancels pending approval, calls SDK
    interrupt, ends active-turn retention, and leaves the task idle and
    resumable on the same Query/session.
  - **P2 ordered interactive operations**: raw SDK input, model,
    permission-mode, effort, approval response, activation, and composer
    discovery. They serialize per task, may wait for an earlier P2 operation,
    and fail if a newer P0/P1 generation superseded them before execution.
  - **P3 independent/background reads**: session catalog, history, and local
    status/config reads. They do not block P0/P1/P2 Query operations; history
    retains its separate same-session serialization lane.
- Higher-tier operations must not wait behind lower-tier per-task operations.
  Persist the rejecting state and invalidate queued work before awaiting an
  asynchronous SDK interrupt/close.
- P2 work submitted while P0/P1 cleanup is in flight is rejected. After P1
  completes, new P2 work may use the same idle Query/session; after P0 the old
  handle never accepts work again.
- An operation already handed to an SDK method cannot be retracted, but a
  later P0/P1 must prevent its stale continuation from persisting state or
  issuing follow-up SDK work.
- A catalog/history/attachment operation that began before a root change must
  recheck current authorization before returning local session data or
  creating/adopting a runtime.
- Idempotent retries return the first operation result but never resurrect work
  invalidated by a later higher-priority operation.
- Define deterministic races for close vs interrupt, authorization removal vs
  Send/control/approval, and shutdown vs every other operation.

## Acceptance Criteria

- [ ] The local page no longer asks users to type newline-separated
      `workspaceRoots`.
- [ ] The computer owner can add an existing local directory through a
      directory-selection UI and see its canonical absolute path in the
      authorized list.
- [ ] Cancelling selection changes nothing; invalid, inaccessible, file, and
      duplicate selections have deterministic behavior.
- [ ] Canonical aliases and covered child roots do not create duplicate
      permissions; adding a parent atomically removes redundant child roots.
- [ ] Selecting a volume root requires a clear second confirmation and cannot
      be persisted through an arbitrary manually supplied path.
- [ ] The computer owner can remove one authorized directory without changing
      other runtime/task settings or deleting local Claude data.
- [ ] Removing one authorized root has deterministic behavior for active,
      idle, interrupted, approval-blocked, and queued task operations under
      that root.
- [ ] A stale remove confirmation stops nothing until the local page refreshes
      the root revision/runtime count and the computer owner confirms again.
- [ ] Close, interrupt, and authorization revocation preempt lower-priority
      operations according to the approved tier model; invalidated queued work
      never reaches the SDK later.
- [ ] Raw Send and model/mode/effort/approval operations retain deterministic
      per-task order, while SDK `priority` fields pass through unchanged.
- [ ] History/catalog reads remain outside the Query lane and cannot delay
      close, interrupt, revocation, controls, or Send.
- [ ] A catalog/history/attachment request that overlaps a directory removal
      returns/persists no data or runtime that the new policy forbids.
- [ ] P0 closes affected raw SDK sockets with the existing `4009` contract,
      while the control socket can still deliver terminal state; P1 keeps the
      reusable session transport available after interruption completes.
- [ ] An authenticated mobile client can list and use the updated allowlist but
      cannot mutate it or escape it through traversal, symlink/junction, path
      case, session cwd, or worktree behavior.
- [ ] Local mutation routes reject missing/wrong origin and CSRF credentials;
      the remote app returns 404 for all new local authorization routes.
- [ ] Authorization changes apply to subsequent workspace/session operations
      without restarting the Agent.
- [ ] Local API, UI, authorization, security, build, and Windows packaged
      release regression tests pass.

## Out of Scope

- Browsing or uploading files inside an authorized directory.
- Remote/mobile directory authorization changes.
- Automatically importing every Claude project or scanning disks for projects.
- Deleting, renaming, moving, or editing Claude workspaces or transcripts.
- Changing model, permission-mode, effort, session-history, or raw SDK message
  wire contracts; this task may change only their runtime scheduling and
  cancellation behavior.
