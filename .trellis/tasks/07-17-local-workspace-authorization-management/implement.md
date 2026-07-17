# Implementation Plan — Local Workspace Authorization Management

## Preconditions

- Work starts from `main` on a new feature branch whose name does not contain
  `codex`.
- No implementation begins until the user reviews `prd.md`, `design.md`, and
  this plan, and `task.py start` changes the task to `in_progress`.
- Only the loopback computer page may mutate authorized directories. Mobile
  continues to use the unchanged read-only `GET /v1/workspaces` contract.
- Adding a root must consume a native-picker selection reference; no add route
  accepts an arbitrary path.
- Removing a root is P0 and terminalizes affected internal task handles without
  deleting Claude sessions or transcripts.
- PocketPilot scheduling tiers never reinterpret
  `SDKUserMessage.priority`; raw SDK input/output shapes remain unchanged.
- Directory changes and capacity saves preserve one another and do not save
  unrelated staged browser edits.

## Ordered Work

1. **Lock shared workspace-path behavior**
   - Extract canonical identity, Windows case folding, volume/UNC-root
     detection, exact-root matching, and descendant containment from the
     current task manager into one task-policy module.
   - Add directory validation (`realpath` plus directory stat) and minimal
     non-overlapping root normalization.
   - Cover equal/case-variant roots, sibling-prefix traps, parent/child roots,
     independent roots, files, missing paths, symlink/junction aliases, drive
     roots, and UNC share roots.

2. **Add the injected Windows picker and selection store**
   - Define a picker interface whose production implementation spawns Windows
     PowerShell 5.1 with fixed `-NoProfile -NonInteractive -STA` arguments and
     no shell/interpolated user input.
   - Bound process output, propagate request cancellation, enforce one active
     picker and an orphan timeout, and map process/framework failures to safe
     errors.
   - Add the short-lived single-use selection store; revalidate canonical
     identity when a token is consumed.
   - Test successful selection, user cancellation, busy picker, timeout,
     aborted request, oversized/invalid output, expired/reused token, changed
     directory identity, and safe error bodies with an injected fake process.

3. **Make root policy updates field-safe and crash-atomic**
   - Keep `taskRuntimeSettingsSchema` as the durable schema, but add a
     capacity-only local configuration schema/writer that preserves roots.
   - Add task-policy repository support for replacing roots and terminalizing
     affected task rows in one SQLite transaction while preserving the latest
     capacity.
   - Implement root snapshots, affected non-terminal counts, add
     normalization, unresolved-legacy projection, revision checking, and exact
     confirmed removal.
   - Emit metadata-only authorization audits with no raw path or subprocess
     error content.
   - Test parent replacement without task shutdown, no child restoration after
     parent removal, independent roots, stale revision/count, capacity/root
     lost-update prevention, and restart persistence.

4. **Replace the task tail lane with preemptible P2 scheduling**
   - Introduce per-task operation generations, explicit queued tickets,
     cancellation leases, immediate pending-ticket rejection, and cleanup of
     empty schedulers.
   - Route raw SDK input, approval response, model/mode/effort, activation,
     composer discovery, and resume through the P2 scheduler.
   - Add cancellation checkpoints before SDK handoff and after awaited SDK
     controls/initialization so stale continuations cannot mutate task state.
   - Keep capacity/attachment/history lanes independent while adding task or
     policy-revision checks at their commit boundaries.
   - Persist `TASK_OPERATION_SUPERSEDED` tombstones for invalidated idempotent
     HTTP operations and retain backward reads of legacy success rows.

5. **Implement deterministic P0/P1 transitions**
   - Refactor interrupt into P1: synchronously invalidate older P2 and cancel
     approvals, reject new P2 during cleanup, call SDK interrupt without
     waiting behind P2, then leave the same session/Query idle when no P0 won.
   - Refactor close and shutdown into P0 helpers that synchronously close
     admission, terminalize state, invalidate queues, cancel approval, and end
     retained turns before awaiting SDK cleanup.
   - Connect confirmed root removal to the same P0 helper for only tasks no
     longer covered by remaining roots.
   - Guard SDK event consumption/session-id persistence against stale live
     generations and preempted sessions.
   - Test interrupt-before-close, close-before-interrupt, repeated P0, shutdown
     races, active SDK call already handed off, queued SDK/control/approval,
     P2 during cleanup, and idle reuse after P1.

6. **Close raw SDK sockets by task**
   - Add an in-memory task SDK connection registry while retaining existing
     device registration for revocation.
   - Register/unregister every raw task socket in both registries.
   - On P0, close only affected raw sockets with the existing
     `4009 / TASK_SESSION_UNAVAILABLE`; do not close the control socket. P1
     keeps the raw socket connected.
   - Test task isolation, device revocation, task close, root revocation,
     shutdown, duplicate cleanup, and terminal control-state delivery.

7. **Revalidate P3 reads after authorization changes**
   - Capture the policy revision after initial catalog/history authorization
     and revalidate before returning SDK session/history rows when it changes.
   - Revalidate create/attach continuations immediately before task persistence
     so removal wins over an in-flight catalog lookup.
   - Prove deferred catalog/history parsing never blocks Send/control/P0 and
     returns no rows after its workspace is revoked.

8. **Register the local-only directory APIs**
   - Add executable Zod schemas and routes for list, pick, add, and confirmed
     remove; inject the picker and narrow task-policy manager through
     `buildLocalAdminApp`.
   - Change `/admin/configuration` and
     `PUT /admin/configuration/tasks` to the capacity-only local projection.
   - Keep every unsafe request behind exact-origin plus CSRF and map domain
     errors to stable local-admin bodies.
   - Prove all new `/admin/authorized-directories*` routes are 404 on the
     remote app and that an add request cannot carry a path.

9. **Build the Authorized directories UI**
   - Extend `api/local-admin.ts` with Zod-owned directory snapshot, picker,
     add, remove, and error contracts; load the directory snapshot alongside
     current page data.
   - Remove `workspaceRoots` and its parser/textarea from ordinary form state;
     keep only concurrent capacity under Runtime and task policy.
   - Add the separate security section with canonical paths, availability,
     volume-root warning, affected-runtime counts, Add, per-row Remove, stale
     refresh, and accessible confirmation/busy/error states.
   - Preserve unsaved runtime/capacity values across Add/Remove and update only
     the server-owned directory snapshot after success.
   - Test cancellation, normal add, covered add, parent replacement, high-risk
     confirm/cancel, remove confirm, stale retry, long path rendering, and
     unrelated unsaved form state.

10. **Run focused cross-layer verification**
    - Run path-policy, picker, settings/repository, task manager, session
      manager, SDK route/socket, local-admin route, runtime, and frontend
      component tests.
    - Inspect SQLite and audit responses after add/removal/preemption for path,
      prompt, SDK frame, directory-content, and raw-error leakage.
    - Verify authenticated `GET /v1/workspaces` reflects changes immediately,
      every remote mutation path is 404, and raw SDK frame deep-equality tests
      still pass.

11. **Run the full quality and release gate**
    - Run `pnpm lint`.
    - Run `pnpm typecheck`.
    - Run `pnpm test`.
    - Run `pnpm build`.
    - Run `pnpm test:release:windows` and confirm the packaged Agent starts,
      serves the new local UI/API, keeps the mutation API off the remote
      listener, and retains the PowerShell folder-picker runtime dependency.
    - Review `git diff --check`, the complete diff, and repository status
      before requesting commit approval.

12. **Update executable Trellis specs**
    - Update backend task-runtime contracts with P0-P3, generation
      invalidation, task socket closure, P3 revalidation, and raw SDK priority
      non-interference.
    - Update local-admin and process-runtime contracts with native picker,
      dedicated directory routes, capacity-only save, CSRF/loopback isolation,
      and Windows release behavior.
    - Update frontend state/component/type-safety contracts for the separate
      immediate-persistence directory section.
    - Update spec indexes only where routing descriptions need the new
      workspace-authorization ownership.

## Validation Matrix

| Area | Required assertions |
| --- | --- |
| Picker boundary | Native adapter uses fixed arguments/no shell, one picker at a time, bounded/cancellable process, safe errors, and cancellation as no change. |
| Add authority | Only an unexpired selection reference can add; direct paths fail; selected path is revalidated and volume roots need explicit risk acceptance. |
| Root normalization | Canonical aliases/case duplicates collapse, existing parent covers child, new parent atomically replaces children, and independent roots remain. |
| Setting ownership | Capacity Save preserves latest roots; Add/Remove preserves latest capacity and unsaved browser edits. |
| Revocation | Policy and terminal task rows commit together; queued P2 never reaches SDK; approvals cancel; affected raw sockets close; Claude transcripts remain. |
| Priority | P0 wins every terminal race, P1 invalidates older P2 and leaves idle reuse, P2 remains FIFO per task, P3 never blocks Query operations. |
| SDK fidelity | `SDKUserMessage.priority` and all raw SDK input/output fields remain unchanged and outside PocketPilot priority/idempotency projections. |
| Idempotency | Retrying a superseded operation returns the same failure and never executes on a newer task generation. |
| Read safety | In-flight catalog/history/attach work rechecks policy and returns/persists nothing after revocation. |
| Transport | P0 closes only affected raw SDK sockets with 4009; control sockets remain long enough to receive terminal state; device revocation still closes both. |
| Local security | All unsafe mutations require exact origin + CSRF; remote app returns 404; no filesystem enumeration or directory content is exposed. |
| Packaging | Full build and Windows packaged-release smoke pass without a new native npm dependency. |

## Risk and Rollback Points

| Risk | Mitigation / rollback |
| --- | --- |
| PowerShell picker hangs or leaves a process | Single active adapter, abort/timeout termination, bounded buffers, injected deterministic tests; disable the add action with a safe unavailable error rather than adding filesystem browsing. |
| Root/capacity writers overwrite one another | Field-specific writers plus synchronous/transactional latest-setting reads; add concurrency regressions before UI work. |
| P0 waits behind or is undone by P2 | Explicit scheduler tickets/generations and synchronous terminal transition; race tests use deferred SDK calls. |
| Already handed SDK control settles after P0/P1 | Lease checkpoints suppress state/follow-up changes; P0/P1 still call SDK interrupt/close and never promise retraction of a call already handed over. |
| Revocation commits but SDK cleanup fails | Fail closed: keep roots removed and tasks terminal, close sockets, surface metadata-only cleanup outcome, and never reauthorize automatically. |
| Stale confirmation stops unexpected tasks | Require policy revision plus expected count, recompute in the same critical section, refresh and reconfirm on conflict. |
| New connection survives task revocation | Task-scoped registry plus terminal lookup on connect; register/close race tests cover both orderings. |
| Superseded retry runs on new generation | Persist an error tombstone compatible with legacy success JSON; verify restart/retry behavior. |
| Legacy invalid root is silently lost or broadened | Preserve it as unavailable/removable, exclude it from authorization, and normalize only roots that can be proven equivalent. |
| Rollback tries to resurrect terminal handles | Roll back code/settings UI only; terminal tasks stay terminal and users reattach unchanged Claude sessions after reauthorization. |

## Review Gates

- Do not run `task.py start` until the user reviews all three planning
  artifacts and explicitly approves implementation.
- After workspace-policy and persistence work, verify canonical normalization
  and crash-atomic removal before connecting runtime cleanup.
- After scheduler work, pass deferred race/idempotency tests before changing
  route or UI behavior.
- After transport work, prove P0 raw-socket closure and control-socket survival
  before UI integration.
- Before commit, complete the Trellis quality check, spec updates, full test
  suite, build, and Windows packaged-release smoke.

