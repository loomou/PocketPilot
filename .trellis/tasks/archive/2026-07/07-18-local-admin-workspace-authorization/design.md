# Design: Local admin workspace authorization

## 1. Design summary

Use the existing `tasks.workspaceRoots` array and explicit Configuration Save/Discard flow, but place all filesystem identity and authorization decisions behind a shared workspace-policy layer. A shared authorization coordinator is instantiated once by the Agent runtime and injected into both `TaskManager` and the local-admin routes. This prevents local-admin saves and remote task admissions from using different path rules or racing past one another.

The local-admin UI gains a feature-local directory-browser dialog and authorization table. Browse/inspect APIs exist only on the loopback app. Mobile clients continue to receive a simple read-only root list from `GET /v1/workspaces`; they never receive host filesystem browsing APIs.

## 2. Architecture and ownership

### 2.1 Pure path policy

Add or adapt `src/tasks/workspace-path-policy.ts` as the reusable owner of path semantics:

- `canonicalizeExistingDirectory(path, { requireAbsolute })`
- `canonicalPathKey(path)` / `canonicalPathsEqual(left, right)`
- `isPathWithinRoot(root, candidate)` using `path.relative` component boundaries
- `isVolumeRoot(path)` including drive, POSIX, and UNC share roots
- exact duplicate detection without collapsing nested roots
- closest available covering-root calculation for table metadata
- inspection of a saved canonical root that requires `realpath(savedPath)` to equal the saved canonical identity

The production resolver uses `node:fs/promises.realpath` plus `stat`. Tests inject a resolver/filesystem adapter and use Windows and POSIX path cases without depending on the host disk. Windows fixture expectations use `realpathSync.native` to avoid false 8.3-path mismatches.

A saved root is effective only when it currently exists, is accessible, is a directory, and still resolves to its saved canonical identity. If the path has been replaced by a symlink/junction to another target, it is unavailable rather than silently reauthorized to the new target.

### 2.2 Authorization coordinator

Add a shared service (provisional name `WorkspaceAuthorizationCoordinator`) under `src/tasks/`. It owns:

- reads and validated replacement of task-runtime settings;
- an in-memory monotonic policy revision;
- a short serial commit/admission lane;
- asynchronous inspection of configured roots;
- workspace admission against currently available roots;
- mobile discovery and local-admin table inspection.

`AgentRuntime` constructs one coordinator using the runtime `SettingsRepository`, passes it to `TaskManager`, and passes the same instance to the local-admin app/routes. No second persistent store is introduced.

Capacity remains part of the same task-runtime settings object. Existing capacity checks read the coordinator's current task settings so root and capacity writes retain one settings owner.

## 3. Linearization and filesystem races

Filesystem canonicalization is asynchronous, so neither save nor admission may rely on a stale settings read taken before `await realpath(...)`.

### 3.1 Admission algorithm

1. Snapshot the coordinator policy revision and configured paths.
2. Canonicalize the requested cwd and inspect configured roots outside the short lane.
3. Enter the commit/admission lane.
4. If the policy revision changed, leave the lane and retry from step 1.
5. Perform the final synchronous component-boundary comparison against the inspected canonical roots and either admit or reject.
6. Leave the lane immediately; the Claude operation/turn runs without holding it.

The admission linearization point is the final comparison in step 5.

### 3.2 Save algorithm

1. Snapshot the current revision and saved task settings.
2. Inspect each requested root outside the lane.
3. Canonicalize every available root; preserve a failed root only when the exact row is unchanged from the saved snapshot; reject newly added failed roots.
4. Reject exact canonical duplicates, preserve explicit nested rows and input order, and verify required high-risk confirmations for newly added volume roots.
5. Enter the lane. If the revision changed, retry validation against the new snapshot.
6. Persist the full validated task settings synchronously and increment the revision before leaving the lane.
7. Return the committed settings.

The save linearization point is the settings write plus revision increment in step 6. Therefore admissions linearized before the save may continue, but after the save response succeeds every later admission observes the new policy. The lane is never held for an entire Claude turn.

Filesystem availability can change immediately after any check; this design defines authorization at the successful admission check and explicitly does not claim an OS sandbox.

## 4. Local-admin backend contracts

### 4.1 Directory browser service

Add `src/local-admin/directory-browser-service.ts` with an injected filesystem/platform adapter. It provides:

- a virtual Computer/root view;
- Windows drive discovery and POSIX `/` plus home shortcut;
- canonical navigation for an optional absolute input path;
- parent-path calculation;
- bounded, deterministically sorted directory-only entries;
- accessible/disabled metadata and a `truncated` flag;
- safe error translation without raw host exception text.

Symlinked/junction directories may be navigated only after backend resolution. Files are filtered before response construction. UNC shares are reached through the absolute-path address bar; the service does not enumerate the network.

### 4.2 Routes

Register the following only in the local-admin app:

```ts
POST /admin/directories/browse
body: { path?: string }
response: {
  currentPath: string | null;
  parentPath: string | null;
  entries: Array<{
    name: string;
    path: string;
    accessible: boolean;
    root: boolean;
  }>;
  truncated: boolean;
}
```

`currentPath: null` denotes the virtual Computer/root view. A non-null current path is canonical and can be placed into the draft only after a successful browse response.

```ts
POST /admin/directories/inspect
body: { paths: string[] }
response: Array<{
  configuredPath: string;
  status: "available" | "unavailable";
  canonicalPath?: string;
  highRisk: boolean;
  coveredBy?: string;
}>
```

Inspection preserves request order. `coveredBy` is the closest other available explicit root that contains the row; unavailable roots neither authorize nor provide effective coverage.

Both routes are unsafe POSTs so the existing local-admin exact-origin/CSRF hook applies. Fastify Zod schemas bound path lengths, array lengths, and listing sizes. Remote app tests prove both paths return 404.

### 4.3 Task-settings update

Keep `PUT /admin/configuration/tasks`, but validate it through the coordinator rather than writing raw settings directly. Its request becomes:

```ts
{
  concurrentTaskCapacity: number;
  workspaceRoots: string[];
  confirmedHighRiskRoots: string[];
}
```

`confirmedHighRiskRoots` is write-only. The response remains `taskRuntimeSettingsSchema`, and persisted data remains only `{ concurrentTaskCapacity, workspaceRoots }`.

Existing saved high-risk roots do not require reconfirmation during unrelated saves. A newly introduced volume/UNC root must be present in the confirmation list after canonicalization or the route returns a stable validation error.

An unchanged unavailable saved row is accepted. A new unavailable row, canonical duplicate, or identity-changing alias is rejected. Runtime and task settings remain two separate existing writes; no cross-record transaction is added in this task.

## 5. Runtime and mobile behavior

### 5.1 Mobile discovery

`TaskManager.authorizedWorkspaceRoots()` becomes asynchronous (or delegates to an asynchronous coordinator query). `GET /v1/workspaces` awaits it and returns available canonical configured rows in persisted order, including explicit nested rows. Unavailable rows are omitted, and availability is reevaluated per query so recovery is automatic.

Update route wording, OpenAPI descriptions, generated OpenAPI output, and tests from “configured roots” to “currently available configured authorized roots.”

### 5.2 Runtime admission coverage

Replace duplicated root canonicalization in `TaskManager` with coordinator admission for:

- workspace/session catalog and history entry points already protected;
- new Claude conversation creation;
- Claude session attachment;
- PocketPilot task creation;
- SDK-session activation;
- task resume;
- every new SDK user message.

For existing tasks, authorize `task.initialCwd` immediately before the operation's first side effect inside the existing task/attachment/capacity lane. Reauthorization is an admission check only; it does not rewrite historical task paths.

Do not add revocation cleanup that interrupts sessions, closes sockets, or terminalizes tasks. An already executing turn continues through existing streaming/event handling. Once idle, subsequent resume/activate/message admissions fail until another current root covers the task cwd. Interrupt, close, and resolution of an already pending approval remain available.

## 6. Frontend design

### 6.1 API ownership

Extend `apps/local-admin/src/api/local-admin.ts` as the only browser owner of the new payload schemas and functions:

- `browseDirectories(csrfToken, path?)`
- `inspectDirectories(csrfToken, paths)`
- extended `saveTaskSettings(...)` request with high-risk confirmations

Every response remains `unknown` until Zod validation. Server paths/names stay opaque.

### 6.2 Configuration tabs and draft

`ConfigurationView` keeps one wrapping form and the existing sticky dirty Save/Discard bar. Add local state for `general | authorized-directories`; because locale changes update context rather than changing component identity, tab and draft state remain mounted.

General contains listener, mobile base URL, and concurrency. Authorized directories contains:

- explanatory copy and summary counts;
- Add directory action;
- table columns Path, Status, Scope/Coverage, Actions;
- available, unavailable, covered, and high-risk badges;
- an explicit empty state.

Add/remove changes only `configuration.tasks.workspaceRoots`. Inspection metadata is derived server data and is not persisted in the draft. Discard restores paths from the saved snapshot and clears unsaved high-risk confirmations.

### 6.3 Directory browser dialog

Implement a feature-local accessible modal shell without adding a new UI dependency. It must expose `role="dialog"`, an accessible title, focus entry/restore, Escape/cancel handling, and disabled/busy states.

The dialog contains root/home shortcuts, breadcrumbs/up navigation, absolute-path input, directory-only rows, truncation notice, Cancel, and Authorize this directory. Navigation fetches the backend; it does not mutate the configuration draft. Authorize adds the verified canonical `currentPath` if it is not an exact duplicate.

Selecting a high-risk root opens a second confirmation step describing the scope. Acceptance records the canonical path in transient confirmation state; cancel returns without changing the draft. The table keeps the high-risk marker after save.

### 6.4 Localization and notices

Add all labels, descriptions, statuses, dialog copy, confirmations, empty states, and stable client error mappings to both `zh-CN` and `en` message resources. Continue storing semantic notice/error codes rather than translated strings so visible notices update immediately on locale change. Do not translate paths, directory names, URLs, or server-provided opaque values.

## 7. Error model

Use stable local-admin errors for invalid absolute path, unavailable path, non-directory path, duplicate canonical root, high-risk confirmation required, listing failure, and oversized/truncated requests. Messages are safe and actionable; OS error strings and file contents are never returned.

Runtime authorization failures continue to use a stable task error indicating the workspace is outside current authorization or unavailable. HTTP and websocket adapters preserve existing TaskError mapping behavior.

## 8. Compatibility and migration

- No database schema migration is required; `workspaceRoots` remains `string[]`.
- Existing valid saved roots become canonical when a successful task-settings save can verify them.
- Existing missing/inaccessible rows remain unchanged and visible as unavailable.
- Existing explicit nested rows are preserved; the new policy never minimizes the set.
- Remote mobile workspace response shape remains a string array, so only availability semantics and documentation change.
- No new runtime npm dependency is required.

## 9. Risk and rollback

| Risk | Mitigation / rollback |
| --- | --- |
| Save/admission race widens access after revocation | Shared revisioned coordinator and deterministic deferred-realpath race tests. |
| Host filesystem enumeration leaks remotely | Register routes only in local app; remote 404 tests; never add `/v1` equivalents. |
| Large/inaccessible directories hang UI | Bounded listings, injected adapter, safe timeout/error behavior where needed, busy/cancel UI. |
| Symlink retargeting changes authorization | Persist canonical path and require current realpath to equal saved identity. |
| Unavailable legacy root blocks all config saves | Preserve unchanged unavailable rows and test unrelated capacity/runtime edits. |
| Root confirmation is lost across Save | Track canonical confirmations in page state and require them server-side only for newly added high-risk roots. |
| UI/modal accessibility regresses | Accessible-role/focus/keyboard component tests. |
| Rollback restores old textarea behavior | Data remains the same settings array; code rollback requires no data migration, though unavailable rows remain stored. |
