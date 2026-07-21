# Audit Claude Code provider parity

## Goal

Inventory the remaining user-visible capability differences between the Codex
provider and the existing Claude Code provider. Classify each difference as an
actionable parity gap, an intentional native-provider difference, or a deferred
enhancement, then recommend implementation priorities.

## Background

PocketPilot now exposes Claude Code through the Claude Agent SDK and Codex
through the official Codex App Server. Both providers use the common Agent API,
shared task runtime, native WebSocket transport, workspace authorization,
capacity, task-state projection, and reconnect policy. The audit must determine
what is still missing after that shared-runtime parity work.

## Requirements

- Compare the two providers across discovery, conversation creation and attach,
  history, native streaming, follow-up input, approvals, interruption, task
  lifecycle, model/mode/effort configuration, reconnect/replay, recovery,
  commands, and live integration coverage.
- Evaluate user-visible capability equivalence rather than identical payloads.
  Claude SDK messages and Codex JSON-RPC frames must remain provider-native.
- Separate true implementation gaps from features that are Claude-only or use
  a different official Codex mechanism.
- Ground every conclusion in current source, tests, project specifications, or
  official provider documentation.
- Assign a recommended priority and bounded follow-up scope to each true gap.
- Do not modify runtime behavior in this planning task.

## Confirmed Findings

### Already aligned at the product workflow level

- Provider discovery, capability negotiation, authorized workspaces, provider
  conversation listing, history loading, new conversation, existing
  conversation attachment, task routing, and separate native identities are
  available for both providers.
- Both providers support native streaming, active-turn input, interruption,
  close/resume, task-state projection, workspace revalidation, and bounded
  reconnect replay. Codex uses `turn/start`/`turn/steer`; Claude uses the SDK
  input stream. This is behaviorally equivalent for the mobile composer, not a
  shared wire format.
- Both providers support model, reasoning/effort, mode, permission, and
  approval workflows. Codex uses `model/list`, `collaborationMode/list`,
  `permissionProfile/list`, native turn parameters, and native JSON-RPC
  approval responses; Claude uses composer REST controls and `PermissionResult`.
- Both providers keep native frames and history rows unchanged. PocketPilot
  adds only task/control metadata on `/v1/events`.

### True gaps or contract gaps

No P0 gap remains in the core conversation workflow. A mobile client can select
a workspace, list/create/attach a conversation, load history, stream a turn,
steer active work, answer approvals, interrupt, reconnect, and continue later
for both providers.

| Priority | Gap | Evidence and user impact | Recommended follow-up |
| --- | --- | --- | --- |
| Deferred | Mobile attachment delivery is not implemented | `src/codex-app-server/provider-adapter.ts:116-127` advertises `attachments: true`, while `src/agent-providers/types.ts:14-25` has no distinction between a computer-side path reference and a mobile upload. There is no authenticated upload/reference API. The product owner explicitly deferred attachment implementation from the next parity rounds. | Do not add upload/reference behavior now. Set the existing Codex capability to unavailable so clients do not expose a broken action; schedule delivery as a separate future task. |
| P1 | Native review, rename, and compact actions are not exposed | The installed 0.144.6 experimental schema has `review/start`, `thread/name/set`, and `thread/compact/start`, but `src/codex-app-server/protocol.ts:9-24` allows only catalogs, history, turn start/steer, and interrupt. Claude mobile guidance exposes review, rename, and compact workflows through raw slash commands. Mobile cannot invoke the equivalent native Codex actions. | Add provider-native action descriptors and allowlisted methods for review, rename, and compact. Do not send Claude slash strings to Codex. Support only inline review on the current thread, with uncommitted changes, base branch, commit, and custom targets. Defer detached review because it creates a new thread that needs separate task binding and event routing. |
| P1 | Codex account/auth/quota state is not visible | Claude exposes raw `auth_status` and `rate_limit_event` messages (`docs/claude-sdk-message-types.zh-CN.md:381-385`). The installed schema has `account/read`, `account/rateLimits/read`, `account/updated`, and `account/rateLimits/updated`; none appear in `src/codex-app-server/protocol.ts`. Mobile cannot distinguish missing/expired authentication or approaching quota until a turn fails. | Add a diagnostics-safe read-only readiness/rate-limit surface. Keep login, logout, reset-credit consumption, tokens, and config writes local-only; do not expose account email or credentials merely to show readiness. |
| P1 | Dynamic skill, hook, and MCP discovery is missing | Claude `system/init` and `system/commands_changed` can update commands and integration state. Codex 0.144.6 exposes `skills/list`, `hooks/list`, `mcpServerStatus/list`, and `skills/changed`, but the current remote allowlist exposes none of the reads and drops `skills/changed`. Mobile therefore cannot build a current provider-native action/skill picker. | Add capability-gated, read-only catalog descriptors and safe change notifications. Do not expose plugin installation, skill/config writes, MCP tool execution, or OAuth from the remote stream. |
| P1 | Safe native status/event coverage is incomplete | `src/codex-app-server/protocol.ts:34-62` already forwards `thread/compacted` and `thread/name/updated`, so those are aligned. It still omits schema notifications including `hook/started`, `hook/completed`, `skills/changed`, `item/autoApprovalReview/*`, `turn/moderationMetadata`, `model/safetyBuffering/updated`, `guardianWarning`, and account status changes. Claude forwards analogous hook, command-change, auth, and rate-limit messages. | Review and version the notification allowlist; expose safe native status events unchanged. Keep filesystem/process/plugin/remote-control notifications outside the conversation stream. |
| P2 | Codex thread-management surface is deferred | The installed schema has `thread/fork`, `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/search`, `thread/rollback`, and thread goal/metadata/settings operations. The current PocketPilot surface only creates, attaches, reads, resumes, unsubscribes, and closes; close deliberately does not archive/delete. | Add explicit, separately authorized actions with confirmation and native identity handling. Never make task close imply archive/delete. |
| P2 | Claude history options are not fully represented for Codex | The common history route accepts `includeSystemMessages`, but `src/codex-app-server/provider-adapter.ts:187-214` ignores it and returns native turns/items. Claude supports system-message filtering and UUID-based pages. A client cannot tell that the filter is unsupported. | Add provider capability metadata for history filters, or reject unsupported options explicitly; keep native Codex turn pagination and history rows unchanged. |
| P2 | Provider availability is optimistic | `src/runtime/agent-runtime.ts:148-168` marks Codex available when the executable exists. Version validation, initialization, and authentication readiness are deferred until the bridge starts. `/v1/providers` can therefore advertise an unusable provider. | Add a bounded safe readiness probe or remember `unhealthy`/`unsupported_version` after failed initialization without exposing executable paths, credentials, or raw process errors. |
| P2 | Live end-to-end coverage is incomplete | `test/codex-app-server/live-contract.test.ts` exercises the raw bridge and skips unless configured. It does not prove the full PocketPilot REST/WebSocket path for approvals, attachments, account state, or newly identified actions. | Add caller-configured provider-level live scenarios incrementally; keep destructive operations and credentials out of fixtures. |
| P3 | Codex reconnect is less efficient than Claude | Claude can reconnect from a known SDK UUID. `src/codex-app-server/journal.ts:80-97` accepts and internally creates cursors, but the Agent WebSocket never returns the current cursor to the client. The Codex mobile guide therefore requires discarding the reducer and replaying the full active turn. Correctness is aligned; bandwidth and reducer efficiency are not. | Add an out-of-band cursor acknowledgement or a documented checkpoint endpoint without inserting cursor fields into native Codex frames. |

### Intentional provider differences, not gaps

- Native Agent WebSocket frames, history row types, IDs, approval result
  schemas, and error objects remain provider-owned.
- Claude can allocate an empty task before the first SDK `session_id`; Codex
  `thread/start` allocates a native thread ID immediately.
- Claude `/clear` emits `conversation_reset` within the same PocketPilot task.
  Codex has no equivalent reset in the installed schema; creating a new Codex
  thread is the correct boundary and must not rotate an existing task's thread.
- Claude accepts raw SDK input with `priority` and `shouldQuery`; Codex uses
  `turn/start` while idle and `turn/steer(expectedTurnId)` while active. Mapping
  those fields would invent behavior.
- Claude composer REST controls and Codex native catalogs/turn parameters are
  different official mechanisms. Claude slash commands must not be fabricated
  for Codex when no native action exists.
- Codex detached review creates a separate native thread. The first native
  action task supports inline review only; detached review requires an explicit
  new task/thread binding workflow and is deferred.
- Codex sandbox, approval policy, collaboration mode, permission profiles, and
  thread status are not Claude permission-mode enums and should not be
  normalized into them.

## Priority Recommendation

For the next implementation sequence, leave attachment delivery deferred.
Implement P1 native actions plus their capability descriptors first, followed
by read-only skills/hooks/MCP catalogs, account/quota, and safe status
visibility. Handle P2 thread management, history options, availability probes,
and live coverage after the P1 surface is stable. Treat P3 replay efficiency as
an optimization after correctness and feature coverage are complete.

## Follow-up Task Map

1. **P1 - Codex native action capabilities** — **done**
   (`07-21-codex-native-action-capabilities`, archived 2026-07-21)
   - Mark Codex mobile attachments unavailable without adding upload behavior.
   - Add provider-native action capability descriptors and allowlisted
     `review/start`, `thread/name/set`, and `thread/compact/start` handling.
   - Restrict `review/start` to inline delivery on the task's current thread;
     support native uncommitted-changes, base-branch, commit, and custom targets.
     Reject detached delivery rather than silently binding its new thread to the
     current task.
   - Update mobile integration docs and contract tests in the same task, so no
     descriptor advertises an action before its transport works.
2. **P1 - Codex read-only status and catalogs** — **done**
   (`07-21-codex-readonly-status-catalogs`, archived 2026-07-21)
   - Add safe account/quota readiness, `skills/list`, `hooks/list`, and
     `mcpServerStatus/list` surfaces plus reviewed status notifications.
   - Redact or omit credentials, tokens, email, local paths, and privileged
     config; keep login/logout/writes local-only.
3. **P2 - Codex thread management** — **done**
   (`07-21-codex-thread-management`, archived 2026-07-21)
   - Add explicit fork/archive/unarchive/delete/search operations with
     confirmation and native identity rules. Path-based fork and deprecated
     `thread/rollback` remain denied.
4. **P2 - Provider readiness and live coverage** — **done**
   (`07-21-provider-readiness-live-coverage`, archived 2026-07-21)
   - Add bounded provider readiness state (TTL/single-flight/reason codes) and
     expand opt-in live coverage for status catalogs and disposable cleanup.
5. **P3 - Codex replay checkpoint** — **open**
   - Return an out-of-band reconnect checkpoint without changing native Codex
     frames.
6. **Deferred - Mobile attachments** — **still deferred**
   - Define computer-path references separately from authenticated mobile file
     transfer before implementing any upload/reference flow.

### Residual after children (not yet scheduled)

- **P2 history options**: common `includeSystemMessages` is still ignored by
  Codex; either advertise capability metadata or reject unsupported filters
  explicitly while keeping native turn/item rows unchanged.
- **Residual status notifications**: moderation/safety/guardian-style events
  remain unreviewed for remote allowlist and are not part of the completed
  account/skills/hooks/MCP catalog surface.
- **P3 replay checkpoint** and **deferred attachments** as listed above.

Tasks 1–4 of this parity sequence are complete. The recommended next
implementation batch is either residual P2 history-option contracts or P3
replay checkpoint; attachments stay deferred.

Evidence inspected includes the current provider adapters and protocol
allowlist, the Claude and Codex mobile guides, archived Codex research and
parity plans, the official Codex App Server manual, and the locally generated
`codex app-server 0.144.6` experimental schema. The official manual confirms
that App Server is the rich-client surface for authentication, history,
approvals, and streamed events and that generated schemas are version-specific.
The generated schema is an audit input only and is not committed.

## Completion Note (2026-07-21)

All four scheduled child implementation tasks finished and archived. This parent
audit task itself remains a planning-only deliverable: findings and the
follow-up map are the product; no runtime code changes belong here. Residual
open items above may become separate future tasks.

## Acceptance Criteria

- [x] The audit lists capabilities already aligned between Claude and Codex.
- [x] Every remaining difference is classified as a parity gap, intentional
      provider difference, or deferred enhancement.
- [x] Every claimed parity gap cites repository evidence and identifies the
      affected user workflow.
- [x] True gaps are prioritized and grouped into independently implementable
      follow-up tasks.
- [x] The final answer clearly distinguishes what mobile clients can use now
      from what remains unavailable.

## Out of Scope

- Implementing any parity gap.
- Wrapping one provider's native protocol in the other provider's message
  schema.
- Inventing Claude slash commands or Claude-specific controls for Codex when
  the official Codex surface has a different mechanism.
