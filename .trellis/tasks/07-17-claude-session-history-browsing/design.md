# Technical Design — Claude Session History Browsing

## Design Summary

PocketPilot remains a thin authenticated transport around the installed Claude
Agent SDK. The public user journey is session-centric even though the existing
PocketPilot task runtime remains the internal owner of a long-lived Query:

```text
authorized workspace
  -> New conversation OR SDK session catalog -> SDK historical messages
  -> transparent internal runtime attachment
  -> raw SDK WebSocket + SDK-native live controls
```

The mobile client never asks the user to create, choose, resume, or continue a
PocketPilot task. A returned task ID is an opaque transport handle used by the
existing raw SDK and control routes, not a conversation identity or transcript.

## Native Behavior to Preserve

The bundled versions are `@anthropic-ai/claude-agent-sdk@0.3.210` and Claude
Code `2.1.210`. PocketPilot must proxy these behaviors:

| User action | Claude Code / SDK behavior | PocketPilot behavior |
| --- | --- | --- |
| Change model | `/model` switches the running session; `Query.setModel()` changes subsequent responses | Call `setModel()` immediately and surface its success/error |
| Change permission mode | CLI/Desktop switch the running session; `Query.setPermissionMode()` is the SDK control | Call `setPermissionMode()` immediately and surface its success/error |
| Change effort | `/effort` updates the running session; `Query.applyFlagSettings()` applies `effortLevel` on the next turn | Call `applyFlagSettings()` immediately; do not restart the Query |
| Send prompt | The next turn reads the session's current controls | Send only the raw `SDKUserMessage`; do not attach a PocketPilot configuration bundle |

All three controls affect the next turn and do not rewrite a turn already in
flight. Claude Code owns validation, policy enforcement, model fallback,
effort fallback, and persistence semantics. PocketPilot serializes control
operations and raw input only to preserve arrival order.

## Public API

### List sessions

```http
GET /v1/sessions?workspace=<authorized-path>&limit=<n>&offset=<n>
Authorization: Bearer <access credential>
```

The Agent canonicalizes and authorizes `workspace`, then calls:

```ts
listSessions({
  dir: workspace,
  limit,
  offset,
  includeWorktrees: false,
  includeProgrammatic: true,
})
```

The response keeps each `SDKSessionInfo` object unchanged:

```ts
{
  sessions: SDKSessionInfo[];
  nextOffset: number | null;
}
```

`nextOffset` is based on SDK rows consumed, not the number left after security
filtering. The client continues while it is non-null, including when a page's
`sessions` array is empty. No total count is invented because the SDK does not
provide one.

Worktree enumeration is disabled because SDK worktrees can lie outside the
selected authorized root. Returned `cwd` values that are present are
canonicalized and checked before delivery so session metadata cannot disclose
an out-of-policy path. A missing `cwd` remains eligible because the SDK call is
already directory-scoped with worktrees disabled.

### Read history

```http
GET /v1/sessions/{sessionId}/messages
    ?workspace=<authorized-path>
    &limit=<n>
    &beforeUuid=<optional-earliest-loaded-sdk-uuid>
    &includeSystemMessages=<boolean>
Authorization: Bearer <access credential>
```

The Agent first calls `getSessionInfo(sessionId, { dir: workspace })`. If the
result has a `cwd`, that path must still belong to the selected authorized
workspace. A missing or out-of-policy session is returned as a stable not-found
response before `getSessionMessages()` runs.

The response is:

```ts
{
  messages: SessionMessage[];
  page: {
    beforeUuid: string | null;
    hasMoreBefore: boolean;
  };
}
```

Each `SessionMessage` is the original SDK-owned value in chronological order.
PocketPilot neither renders nor stores it. `includeSystemMessages` is explicit
and defaults to the SDK default (`false`). `limit` defaults to 50 and is capped
at 50 for this MVP so one response cannot mount an unbounded conversation on a
mobile device.

The installed SDK has forward `offset`/`limit` parameters but no reverse page,
total count, streaming history iterator, or UUID cursor. Its local
implementation reads/parses the transcript, reconstructs the active
parent-UUID chain, filters it, and only then slices. To provide desktop-style
latest-message entry without changing message objects, the Agent uses this
stateless algorithm:

1. call `getSessionMessages()` for the validated session and selected
   `includeSystemMessages` mode;
2. without `beforeUuid`, return the final 50 filtered messages;
3. with `beforeUuid`, find that UUID in the current filtered chain and return
   up to 50 messages immediately before it;
4. set the next `beforeUuid` to the first returned SDK message UUID only when
   still earlier messages exist.

The cursor is response/query metadata and is never inserted into a
`SessionMessage`. If the anchor disappeared because the Claude chain changed,
return `HISTORY_CURSOR_STALE`; the client clears loaded history and requests
the latest page. One cursor sequence must keep `includeSystemMessages`
unchanged.

History reads for the same `(workspace, sessionId)` use a dedicated serial lane
so rapid scroll callbacks cannot trigger parallel full transcript parses. The
lane is separate from task/Query control lanes: history latency or failure does
not delay raw socket activation, composer readiness, controls, or sending.
PocketPilot retains no full history snapshot between requests, accepting that
user-initiated older pages repeat SDK parsing in exchange for bounded memory
and no second transcript cache.

If the SDK read fails, return `CLAUDE_HISTORY_UNAVAILABLE` with safe retryable
text. The conversation screen keeps its attached Query and composer usable.

### Create a new conversation

```http
POST /v1/sessions
Authorization: Bearer <access credential>
Content-Type: application/json

{
  "operationId": "<uuid>",
  "workspace": "<authorized-path>",
  "workspaceRiskAccepted": true
}
```

This is the workspace page's **New conversation** action. It creates one idle
internal task with origin `claude-session`, the canonical authorized cwd, and
no SDK session ID yet. It stores no PocketPilot model, permission-mode, or
effort override. The metadata-only response uses the existing `created` task
action, and the client treats `task.id` as an opaque runtime handle.

When the client connects the raw SDK socket, the Agent installs the subscriber
first and then opens a Query with `cwd` but without `Options.resume`, `model`,
`permissionMode`, or `effort`. Claude Code therefore resolves the same local
defaults it would use when started directly in that directory. The unchanged
raw `system/init.session_id` is persisted as the runtime's SDK session
reference. No synthetic session metadata is added to the list; the new
conversation appears there later when the SDK itself considers it listable.

The same idempotency, workspace-risk, authentication, capacity, approval,
control, and privacy contracts apply. Creating/opening the idle conversation
does not consume an active-turn capacity slot; its first query-triggering raw
message does.

### Attach the selected session

```http
POST /v1/sessions/{sessionId}/attach
Authorization: Bearer <access credential>
Content-Type: application/json

{
  "operationId": "<uuid>",
  "workspace": "<authorized-path>",
  "workspaceRiskAccepted": true
}
```

Attachment validates the same workspace/session pair as history, then reuses or
creates exactly one non-terminal internal task whose `sdkSessionId` is the
selected Claude session. The response uses the existing metadata-only task
operation result with a new `attached` action. The client treats `task.id` as
an opaque runtime handle and does not present the task snapshot in the UI.

Selection is the user action that triggers attachment. There is no separate
continue/resume button. An interrupted internal runtime is transparently made
idle and later reopened with `Options.resume`; no prompt is resubmitted.

`workspaceRiskAccepted` preserves the existing security contract. The mobile
surface may satisfy it through the existing workspace-risk acknowledgement; it
must not describe it as a PocketPilot task-management action.

### Bootstrap composer controls

After attachment, the client opens the existing raw socket:

```http
GET /v1/tasks/{taskId}/sdk
```

For a new or attached Claude session, the route first installs the raw SDK
subscriber and then asks `TaskManager` to activate the runtime. This ordering
ensures the client sees the original SDK `system/init` message rather than a
PocketPilot projection. That message is authoritative for the Query's selected
model and permission mode.

Add a task-scoped composer-options read:

```http
GET /v1/tasks/{taskId}/composer-options
```

It returns only control-plane SDK data:

```ts
{
  models: ModelInfo[];
  supportedPermissionModes: PermissionMode[];
  effortLevel: EffortLevel | null;
}
```

`models` comes from `Query.supportedModels()` and therefore carries per-model
`supportedEffortLevels`. `effortLevel` is the SDK-resolved configured starting
level or `null` when Claude Code owns the model default; later successful
PocketPilot effort controls update only this live runtime snapshot. The client
uses the raw `system/init` and `system/status` messages for actual model/mode
state and the composer-options response for selectable values.

`PermissionMode` remains the pinned SDK contract, not the narrower Claude.ai
Remote Control product menu. Claude Code may reject a mode under current
account, startup, or managed-policy constraints; PocketPilot propagates that
error and does not silently choose another mode.

### Deferred Query capabilities

The installed Query can also report Slash Commands, Skills, Agents, MCP
server/tool status, context usage, background tasks, and account information.
Those are not part of this API increment. The composer-options response stays
limited to the model, permission-mode, and reasoning-strength data required by
the reviewed bottom composer. Later tasks can define privacy-safe projections
and UI for the deferred capabilities.

### Live controls

Keep the current model and permission routes and add effort:

```http
POST /v1/tasks/{taskId}/model
POST /v1/tasks/{taskId}/permission-mode
POST /v1/tasks/{taskId}/effort
```

The effort body is metadata-only and idempotent:

```ts
{
  operationId: string;
  effortLevel: EffortLevel | null;
}
```

`null` clears PocketPilot's live flag-setting override so Claude Code falls
back through its own configuration/default precedence. Named values are
forwarded through `applyFlagSettings()` without checking them against a
PocketPilot model table. The installed SDK's `ModelInfo` catalog informs the
UI; Claude Code owns any supported-level fallback.

The generated SDK `Settings.effortLevel` declaration omits the session-only
`max` value even though both `EffortLevel`, `ModelInfo`, and the official
`applyFlagSettings()` documentation support it. Isolate that mismatch in the
Claude SDK adapter and cover it with the opt-in live contract test. Do not
reopen the Query and do not use deprecated `setMaxThinkingTokens()`.

The existing model-idle restriction is removed. Model, permission, and effort
controls may be accepted while a turn is active because the SDK documents that
they apply on the next turn. A client must await the control response before
sending when it requires command-before-prompt ordering, matching completion
of `/model`, a mode switch, or `/effort` before typing the next prompt.

## SDK Adapter

Add a small injected catalog adapter around the public SDK functions:

```ts
type ClaudeSessionCatalog = {
  list(options: ListSessionsOptions): Promise<SDKSessionInfo[]>;
  getInfo(sessionId: string, options: GetSessionInfoOptions):
    Promise<SDKSessionInfo | undefined>;
  getMessages(sessionId: string, options: GetSessionMessagesOptions):
    Promise<SessionMessage[]>;
  resolveSettings(options: ResolveSettingsOptions): Promise<ResolvedSettings>;
};
```

Production delegates directly to SDK exports. Tests inject fakes; routes never
read Claude's files or settings themselves.

Extend `ClaudeSdkSession` with `applyFlagSettings()`/`setEffortLevel()` and the
existing initialization/model discovery result. It continues to yield every
SDK message unchanged. Observing `system/init` for readiness/control metadata
must happen before yielding the same object; the observation may not clone,
filter, wrap, or delay it.

## Task Runtime and Persistence

The task runtime is retained because it already owns:

- one long-lived streaming SDK input and Query;
- approvals, interruption, capacity, and shutdown;
- raw SDK/control channel isolation and transient replay;
- device authentication, revocation, idempotency, and metadata-only audit.

Add a task origin field (`pocketpilot` or `claude-session`) and allow
`permissionMode` to be null. Existing explicit task creation remains
`pocketpilot` and keeps its current persisted initial controls. A discovered
session attachment is `claude-session`, stores the selected `sdkSessionId`
before Query creation, and opens the Query without PocketPilot model or
permission overrides. A new conversation is also `claude-session` but starts
with `sdkSessionId: null`; it opens without `resume` and persists the session ID
observed from raw SDK initialization. Later selector changes for both paths are
live SDK controls, not durable PocketPilot preferences.

This distinction prevents an Agent restart from reapplying a PocketPilot copy
of settings that Claude Code itself would not persist. Model restoration,
permission defaults, and effort defaults remain Claude-owned.

Enforce one non-terminal task per non-null SDK session ID with a partial unique
index. The migration makes older duplicate rows terminal except for the most
recently updated row before creating the index. The single-process attachment
lane then performs lookup/create/reuse atomically. If a conflict still occurs,
return a stable session-conflict error and start no second Query.

Task state remains internal. An attached idle Query does not count against
active-turn capacity; sending the first query-triggering SDK message performs
the existing capacity check. Selecting a session therefore loads the screen
without consuming an execution slot, while actual concurrent model work stays
bounded.

## History and Live-Stream Reconciliation

History and live output intentionally use different SDK APIs and shapes:

- `getSessionMessages()` supplies chronological `SessionMessage[]` history;
- the Query supplies live raw `SDKMessage` objects on the raw socket.

PocketPilot does not merge them into a transcript. The mobile client uses a
virtualized list, prepends older 50-message pages, appends live SDK output, and
deduplicates by SDK UUID where available. To cover a message written between
the history read and runtime attachment, it may refresh the latest page after
the raw socket is active. The Agent must not persist a second transcript or
copy history into the raw live stream.

History is display data only. The client never sends loaded history back over
the raw input socket; continuation uses `Options.resume`, and Claude Code alone
owns context-window compaction.

## Security and Privacy

- Bearer authentication is required for catalog, history, attachment,
  composer options, controls, and both WebSockets.
- Canonical workspace authorization occurs before every SDK discovery/history
  call and again before attachment.
- `includeWorktrees` stays false for the selected-root boundary.
- Session summaries, prompts, messages, tool content, and raw frames never
  enter task rows, audit rows, operation results, application logs, or error
  text.
- Attachment idempotency stores only the existing task metadata result; it does
  not cache `SDKSessionInfo` or `SessionMessage` content.
- Routes return stable error codes without leaking local filesystem structure
  or raw SDK exceptions.

## Errors

Add stable task-domain errors as needed:

| Condition | Result |
| --- | --- |
| Workspace is nonexistent/outside policy | `WORKSPACE_NOT_AUTHORIZED` |
| Session is missing, has an unauthorized cwd, or cannot be proven to belong to the selected workspace | `CLAUDE_SESSION_NOT_FOUND` |
| `beforeUuid` no longer exists in the selected filtered chain | `HISTORY_CURSOR_STALE`; client reloads latest page |
| SDK cannot read/parse history | `CLAUDE_HISTORY_UNAVAILABLE`; attached conversation remains usable |
| More than one runtime would own the same SDK session | `CLAUDE_SESSION_CONFLICT` |
| SDK catalog/history/readiness fails | `TASK_SESSION_UNAVAILABLE` with safe text |
| Effort value is outside the pinned SDK enum | request validation error; call no SDK method |
| SDK rejects model/mode/effort | propagate a stable control failure; do not fall back in PocketPilot |

## OpenAPI and Compatibility

The change lands directly in the unpublished `/v1`. Add a `Sessions` tag and
generate schemas from the executable Zod route contracts. SDK-owned session,
history, model, and message objects are documented as open/passthrough shapes
with `@anthropic-ai/claude-agent-sdk@0.3.210` named as source of truth.

Keep the raw `/v1/tasks/{taskId}/sdk` `x-websocket` contract unchanged: client
frames are raw `SDKUserMessage`; server frames are raw `SDKMessage`. Update its
notes to explain that a session attachment may activate the Query after the
socket subscriber is installed. `/v1/events` remains control-only.

The task schema migration is the rollback boundary. Code rollback after
attached rows exist must retain nullable permission/origin compatibility or
terminalize/remove only the internal attached rows before restoring the older
schema. No Claude transcript migration exists.

Slash Commands, Skills, Agents, MCP status, context usage, background-task
status, account data, and ultracode/workflow controls require separate future
review and are not compatibility requirements for this rollout.

## Likely Files

- `src/claude-sdk/session-catalog.ts`, `session.ts`
- `src/tasks/task-manager.ts`, `task-repository.ts`, `task-types.ts`,
  `errors.ts`
- `src/storage/schema.ts`, `drizzle/*`
- `src/remote-api/session-routes.ts`, `task-routes.ts`,
  `task-sdk-routes.ts`, `app.ts`
- `src/api-docs/mobile-openapi.ts`, generated OpenAPI asset
- `src/runtime/agent-runtime.ts`
- Matching SDK, task, route, WebSocket, storage, OpenAPI, build, and release
  tests
