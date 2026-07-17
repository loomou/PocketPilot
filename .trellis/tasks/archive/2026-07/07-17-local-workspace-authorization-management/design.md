# Technical Design — Local Workspace Authorization Management

## Design Summary

The loopback administration page becomes the only writer of the workspace
allowlist. Adding a directory starts a Windows-native folder picker in the
local Agent, converts the result into a short-lived selection reference, and
persists only that referenced canonical directory. Removing a directory is a
P0 security operation: policy rejection, task terminalization, queued-work
invalidation, approval cancellation, and raw task-socket closure occur before
the route waits for SDK cleanup.

`workspaceRoots` remains the durable task-policy field and
`GET /v1/workspaces` remains the read-only mobile projection. The public Claude
SDK message, control, session catalog, history, model, mode, and effort
contracts do not gain a PocketPilot wrapper or scheduling field.

```text
loopback page
  -> native picker -> one-use selection -> canonical root normalization
  -> task-runtime settings + local authorization list
                              |
                              +-> GET /v1/workspaces (read-only)
                              +-> task/session authorization

remove root
  -> synchronous P0 commit: revoke policy + terminalize affected task rows
  -> invalidate task operation queues + cancel approvals + close raw sockets
  -> interrupt/close affected SDK Queries
```

## Ownership and Boundaries

### Local administration

- `src/local-admin/` owns the folder-picker adapter, in-memory selection
  references, local-only routes, route schemas, CSRF enforcement, and safe
  error translation.
- Production invokes Windows PowerShell 5.1 directly with argument arrays;
  tests inject a picker adapter and never open a real dialog.
- The remote Fastify app receives none of the picker or mutation routes.

### Task policy and runtime

- `src/tasks/` remains the owner of canonical workspace containment,
  `workspaceRoots`, task metadata, SDK Query lifetime, operation ordering, and
  P0/P1 preemption.
- Extract the current path-containment function into one task-policy module so
  authorization, root normalization, affected-task counting, and revocation
  use the same Windows-aware comparison.
- `TaskManager` exposes local-management operations through a narrow interface;
  HTTP routes do not update settings or task rows directly.

### Runtime composition and transports

- `AgentRuntime` constructs the picker, task-scoped SDK connection registry,
  `TaskManager`, and local app, then injects only the capabilities each app
  needs.
- Device connection ownership remains unchanged. A new task-scoped registry
  additionally owns raw SDK sockets so P0 can close sockets for one task with
  `4009 / TASK_SESSION_UNAVAILABLE` without disconnecting the control socket.

## Local API Contracts

All state-changing routes use the existing exact-origin and CSRF hook.

### Read authorized directories

```http
GET /admin/authorized-directories
```

```ts
type AuthorizedDirectorySnapshot = {
  revision: number;
  directories: Array<{
    path: string;
    nonTerminalRuntimeCount: number;
    status: "available" | "unavailable";
    volumeRoot: boolean;
  }>;
};
```

Counts include every non-terminal task state (`idle`, `executing`,
`awaiting_approval`, and `interrupted`) whose canonical `initialCwd` would no
longer be covered after that row alone is removed. Counts are recomputed by the
Agent; the browser is never authoritative.

An unresolved root inherited from the old text setting is shown as
`unavailable` and remains removable, but cannot authorize new work while it
cannot be canonicalized. The migration never silently broadens it or deletes
it. Resolvable legacy roots are canonicalized and collapsed on the first
successful authorization mutation.

### Open the native picker

```http
POST /admin/authorized-directories/pick
```

```ts
type DirectoryPickResponse =
  | { status: "cancelled" }
  | {
      status: "selected";
      selectionId: string;
      path: string;
      expiresAt: number;
      volumeRoot: boolean;
    };
```

The route returns a canonical display path but never accepts a path. Only one
picker may be active. A second request receives
`DIRECTORY_PICKER_BUSY`. Cancelling the dialog returns `status: "cancelled"`
and creates no token.

### Persist a selected directory

```http
POST /admin/authorized-directories
Content-Type: application/json

{
  "selectionId": "<opaque one-use reference>",
  "volumeRootRiskAccepted": false
}
```

The response contains the new complete snapshot plus:

```ts
{
  result: "added" | "already-covered";
  selectedPath: string;
  coveringPath?: string;
  removedRedundantPaths: string[];
  snapshot: AuthorizedDirectorySnapshot;
}
```

The route consumes an in-memory picker selection, revalidates the directory,
and never accepts an arbitrary filesystem path. A volume/UNC share root
requires `volumeRootRiskAccepted: true`; other selections ignore the flag.

### Remove an authorized directory

```http
POST /admin/authorized-directories/remove
Content-Type: application/json

{
  "path": "<exact path from the current snapshot>",
  "revision": 7,
  "expectedNonTerminalRuntimeCount": 2,
  "runtimeStopAccepted": true
}
```

Removal may accept a path because it must case-insensitively match exactly one
currently stored row; it cannot introduce or expand authorization. The
revision and count prevent a stale confirmation from stopping a different set
of runtimes. A mismatch returns a stable conflict and the UI refreshes before
asking again. Success returns the new snapshot and the actual stopped task
count.

`PUT /admin/configuration/tasks` changes to a capacity-only request/response:

```ts
{ concurrentTaskCapacity: number }
```

Its policy writer preserves the current `workspaceRoots`. Conversely,
directory Add/Remove preserves the latest concurrent capacity. This prevents
either action from saving stale fields owned by the other form.

## Native Windows Picker

The production adapter uses:

```text
powershell.exe -NoLogo -NoProfile -NonInteractive -STA -Command <fixed script>
```

The fixed script loads `System.Windows.Forms`, creates
`FolderBrowserDialog`, and writes one compact UTF-8 JSON result. No user value
is interpolated into the command. Node launches it without a shell and applies
these controls:

- one active process at a time;
- bounded stdout/stderr buffers;
- an interaction timeout that terminates an orphaned picker;
- request-abort propagation that terminates the child process;
- safe stable errors that omit raw PowerShell/framework text;
- cancellation as a successful no-change result.

The selected path must pass `realpath` and `stat().isDirectory()`. The add step
repeats those checks and compares the new canonical identity with the token so
a path swap between selection and confirmation cannot grant a different
directory.

Selection references are cryptographically random, in-memory, single-use, and
short-lived. Expired, reused, or unknown references return
`DIRECTORY_SELECTION_UNAVAILABLE`. Restarting the Agent invalidates every
reference by design.

## Canonical Root Policy

Canonical comparison uses a stable key that normalizes separators, preserves a
volume root separator, and folds case on Windows. Containment uses the same
`relative()`-based boundary check already used by task authorization, after
both values have been canonicalized. It must not use string-prefix matching.

For an add operation:

1. Canonicalize and validate the selected directory.
2. Resolve every currently usable root through the same policy helper.
3. If an existing root equals or contains the selection, return
   `already-covered` and change nothing.
4. Otherwise add the selected root and remove every existing child root it
   contains in the same settings update.
5. Preserve independent and unresolved legacy roots.

Adding a parent is an authorization expansion. It does not terminalize tasks
under children removed as redundant because their effective authorization is
continuous. Removing that parent later does not recreate the old children.

Any path equal to `parse(path).root`, including a drive root or UNC share root,
is high risk and requires the explicit add confirmation.

## P0 Directory Revocation Transaction

Authorization mutations serialize on a small policy lane. Removal performs the
following critical section without an `await`:

1. Re-read the latest task settings and verify the submitted revision, exact
   root, confirmation, and affected count.
2. Build the remaining root set and select non-terminal tasks whose canonical
   `initialCwd` is not covered by any remaining available root.
3. In one SQLite transaction, replace only `workspaceRoots` in the
   `task-runtime` setting and terminalize the selected task rows.
4. Increment the global authorization revision and each affected task's
   operation generation; mark live resources closed; reject queued P2 tickets;
   cancel pending approvals; clear pending-query accounting; publish terminal
   control state; end retained turns; and close task SDK sockets with `4009`.

Only after that synchronous block does the method call SDK `interrupt()` and
`close()` for affected Queries. Cleanup is best effort and bounded; a cleanup
failure never rolls policy back or make an old task handle non-terminal. The
local route returns success only after every affected Query has received both
cleanup attempts (or the bounded wait expires).

This ordering is atomic to callers and fail-closed across process failure:
once the settings transaction commits, new work is unauthorized and the task
rows are terminal even if the Agent exits before asynchronous SDK cleanup
settles. Claude session files and transcripts are never modified.

## Runtime Operation Priority

| Tier | Operations | Admission and ordering | Resulting state |
| --- | --- | --- | --- |
| P0 | Agent shutdown, explicit task close, root removal for affected tasks | Bypass P2 queues, synchronously reject admission, invalidate queued P2, cancel approval, close raw socket, interrupt/close Query | `terminal`; old handle is non-resumable |
| P1 | Explicit task interrupt | Bypass P2 queue, invalidate older queued P2, cancel approval, interrupt Query | transiently rejecting, then `idle` on the same Query/session |
| P2 | raw SDK input, approval response, model/mode/effort, activation, composer discovery, existing resume control | Ordered per task; execute only against the generation captured at admission | SDK-defined effect; controls apply to the next turn |
| P3 | catalog/history/status/config/list reads | Independent from the Query scheduler; history retains only its same-session parse lane | no task transition |

New conversation and session attachment have no existing task lane. They
capture the global authorization revision, use their existing admission lane,
and revalidate authorization immediately before creating/adopting a task so a
concurrent P0 removal wins.

`SDKUserMessage.priority` remains part of the untouched SDK object. The Agent
does not map `now`, `next`, or `later` to these tiers.

## Preemptible P2 Scheduler

Replace the tail-only task `SerialExecutor` with a task operation scheduler
that owns explicit pending tickets and a monotonically increasing generation.

- Enqueue captures the current generation and preserves FIFO order within P2.
- P0/P1 increments the generation and immediately rejects every pending older
  ticket with `TASK_OPERATION_SUPERSEDED`; those tickets never call the SDK.
- An executing ticket receives a lease. It checks the lease immediately before
  every SDK handoff and after every awaited SDK call before persisting state or
  issuing a follow-up action.
- An SDK call already handed off cannot be retracted. P0/P1 invokes SDK
  interrupt/close concurrently; the stale P2 continuation may settle but may
  not write task state or submit later work.
- P2 arriving while P0/P1 cleanup is in flight is rejected rather than allowed
  to overtake the preemption. After P1 completes and the task becomes idle,
  new P2 is admitted on the new generation. P0 never reopens admission.

The capacity and attachment lanes remain independent admission mechanisms,
but every task-affecting continuation checks its task lease or global policy
revision before committing.

## P0/P1 Race Rules

- **Interrupt then close:** interrupt marks the old generation stale; close
  then terminalizes the task. The interrupt finalizer observes terminal/newer
  generation and cannot write `idle`. Close wins.
- **Close then interrupt:** close terminalizes synchronously; interrupt returns
  the terminal error and does not call SDK interrupt a second time solely to
  resume the handle.
- **Root removal vs Send/control/approval:** removal commits terminal state and
  invalidates queued operations before SDK cleanup. Queued operations fail;
  an already handed SDK call may settle but cannot persist or continue.
- **Root removal vs explicit close:** both are P0 and terminal state is
  idempotent. Removal still commits the policy change; SDK cleanup and socket
  closure run at most once per live resource.
- **Shutdown vs all operations:** `shuttingDown` is set and all task generations
  are invalidated before listener/storage cleanup. Every later operation
  rejects; all non-terminal rows become terminal.

SDK event consumers also check that the emitting session still belongs to the
current live generation. Late messages from a preempted/closed Query cannot
republish raw output, restore a session ID, or move terminal/interrupted state.

## Idempotency Under Preemption

HTTP controls retain the 24-hour `(deviceId, operationId)` contract. A queued
idempotent P2 operation invalidated by P0/P1 persists a metadata-only
supersession tombstone in `operation_results`. A retry rethrows the same stable
`TASK_OPERATION_SUPERSEDED` outcome and never captures the newer generation.

Existing successful result rows remain readable. The JSON reader accepts the
legacy success shape and the new tagged outcome shape, so no durable schema
migration is required. Raw SDK frames remain outside this cache and retain
their unmodified optional SDK UUID/priority fields.

## P3 Authorization Revalidation

Catalog/history calls capture the authorization revision only after their
initial workspace check. They may finish SDK/local transcript parsing after a
root is removed, but before returning any rows they compare the revision and,
if it changed, revalidate the canonical workspace against the current roots.
An unauthorized result becomes `WORKSPACE_NOT_AUTHORIZED`; no stale session or
history data is returned.

P3 reads never enter a task P2 lane and therefore cannot delay Send, controls,
interrupt, close, or revocation. Local status/config/audit reads remain simple
independent snapshots.

## Local UI State

The React page loads authorized directories alongside the existing snapshot
and renders a separate **Authorized directories** security section. Runtime
and capacity form edits remain ordinary staged form state.

- **Add directory** disables only competing mutations, waits for the picker,
  asks the second volume-root confirmation when required, commits the selection,
  and replaces the list with the returned server snapshot.
- **Remove** shows the current affected-runtime count and requires explicit
  confirmation. A stale revision/count error refreshes the list and requires a
  new confirmation.
- Add/Remove do not call the ordinary Save handler and do not overwrite
  unsaved listener, mobile URL, or capacity edits.
- Paths render as text, not HTML, and long paths wrap without changing the
  action layout. Busy/error/success state follows the page's existing local
  React-state pattern; no global store is added.

## Security, Errors, and Auditing

Stable local errors include picker unavailable/busy, selection unavailable,
invalid directory, volume-root risk not accepted, stale authorization
snapshot/count, authorized root not found, and runtime operation superseded.
Raw process, filesystem, SQLite, and SDK exception text never crosses the API.

Authorization audits contain only operation/outcome metadata, affected task
count, and a non-reversible root fingerprint when correlation is needed. They
contain no prompts, directory contents, environment values, raw path, picker
stderr, SDK frames, or transcript data.

## Compatibility, Rollout, and Rollback

- The persisted `task-runtime` JSON shape stays
  `{ concurrentTaskCapacity, workspaceRoots }`; existing remote workspace and
  task/session consumers continue to read it.
- The local configuration HTTP shape intentionally becomes capacity-only.
  The bundled local page and Agent ship together, so no compatibility alias for
  raw root writes is retained.
- No database migration is required. Selection tokens, policy revision, task
  generations, and socket registries are in-memory process state.
- Rollback restores the old local UI/API code while the existing root setting
  remains readable. Tasks terminalized by a security revocation stay terminal;
  rollback never attempts to resurrect them. Claude transcripts remain intact.
- Windows packaged-install smoke is the release gate. Non-Windows/test builds
  may start the Agent, but invoking the production picker returns the stable
  picker-unavailable error.

## Likely Files

- `src/local-admin/app.ts`, `configuration-routes.ts`, new directory routes,
  picker adapter, and selection store
- `src/tasks/task-manager.ts`, `task-repository.ts`, `settings.ts`, and new
  workspace-policy / operation-scheduler helpers
- `src/remote-api/task-sdk-routes.ts`, `app.ts`, and a task SDK connection
  registry
- `src/runtime/agent-runtime.ts`
- `apps/local-admin/src/api/local-admin.ts` and
  `features/administration/administration-page.tsx`
- Matching local route, picker, path policy, task race, WebSocket, runtime,
  frontend, build, and Windows release tests

