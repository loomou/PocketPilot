# Codex App Server Integration

This document defines how a PocketPilot client integrates with the `codex`
provider. It describes protocol and lifecycle behavior, not a mobile framework
or UI implementation.

PocketPilot controls the locally installed official Codex App Server over its
stdio JSONL transport. App Server is never exposed directly to the LAN. The
authenticated PocketPilot API remains the only remote boundary.

## Provider discovery

Read `GET /v1/providers` before showing Codex as available. PocketPilot refreshes
provider readiness on this discovery route (and on capabilities) with a short
server-side TTL. Treat `status` as authoritative for the current response and
never infer availability from a local path or a previous launch.

Then read `GET /v1/providers/codex/capabilities` and select the codec identified by:

```json
{
  "id": "codex",
  "status": "available",
  // "reasonCode": "CODEX_COMMAND_NOT_FOUND" // only when unavailable
  "protocolVersion": "codex-app-server@0.144",
  "capabilities": {
    "activeTurnSteering": true,
    "approvals": true,
    "attachments": false,
    "effort": true,
    "historyFilters": {
      "includeSystemMessages": false
    },
    "historyPagination": "cursor",
    "interrupt": true,
    "modes": true,
    "models": true,
    "nativeActions": {
      "compact": {
        "availability": "idle",
        "method": "thread/compact/start",
        "startsTurn": true
      },
      "rename": {
        "availability": "always",
        "method": "thread/name/set",
        "startsTurn": false
      },
      "review": {
        "availability": "idle",
        "deliveries": ["inline"],
        "method": "review/start",
        "startsTurn": true,
        "targetTypes": [
          "uncommittedChanges",
          "baseBranch",
          "commit",
          "custom"
        ]
      }
    },
    "newConversation": true,
    "resumeConversation": true,
    "streamProtocol": "codex-app-server-json-rpc",
    "threadManagement": {
      "archive": true,
      "delete": true,
      "fork": true,
      "includeArchived": true,
      "search": true,
      "unarchive": true
    }
  }
}
```

Do not infer provider availability from local paths or from a previous run.

## Identity model

Codex identities remain separate:

| Identity | Owner | Purpose |
| --- | --- | --- |
| `taskId` | PocketPilot | Authenticated API, WebSocket, task state, and routing |
| `threadId` / `nativeConversationId` | Codex | Persistent conversation branch |
| `sessionId` / `nativeSessionId` | Codex | Root session tree identity; forks may share it |
| `turnId` / `activeTurnId` | Codex | One active user request and its execution |
| `itemId` | Codex | Message, reasoning, command, file change, or tool item |
| JSON-RPC `id` | Requesting peer | Correlates one request and response |
| `afterCursor` | PocketPilot transport | Replays retained native frames after reconnect |

Never substitute `taskId` for a Codex ID. PocketPilot may remap JSON-RPC IDs on
its private shared stdio connection to isolate simultaneous tasks, but the
client receives its original request ID unchanged.

## Conversation resources

All conversation routes require an authorized `workspace`.

```text
GET  /v1/providers/codex/conversations
POST /v1/providers/codex/conversations
GET  /v1/providers/codex/conversations/{threadId}
POST /v1/providers/codex/conversations/{threadId}/attach
POST /v1/providers/codex/conversations/{threadId}/fork
POST /v1/providers/codex/conversations/{threadId}/archive
POST /v1/providers/codex/conversations/{threadId}/unarchive
POST /v1/providers/codex/conversations/{threadId}/delete
```

List requests include Codex CLI, VS Code, and App Server thread sources and
accept optional `includeArchived=true` and `searchTerm` filters. Rows are
native Codex thread objects inside the REST response envelope:

```json
{
  "conversations": [
    {
      "id": "019...",
      "sessionId": "019...",
      "cwd": "D:\\Projects\\demo",
      "turns": []
    }
  ],
  "page": { "cursor": null, "hasMore": false }
}
```

Creating a conversation calls native `thread/start`, so the returned task has
`nativeConversationId` and `nativeSessionId` immediately. Attaching calls
`thread/read` for authorization and reuses an existing non-terminal task for
the same Codex thread when one exists. Selecting a conversation is the attach
action; clients must not replay historical messages as a new prompt.

Fork returns a new task bound to the forked native thread. Archive, unarchive,
and delete return `{ action, task: null }`. Archive and delete require
`confirm: true`; missing/false confirm returns `CONFIRMATION_REQUIRED`.
Archive does **not** auto-close bound PocketPilot tasks. Delete terminals any
local non-terminal PocketPilot task for that native conversation after native
delete succeeds and publishes a `task.state` control event.

History uses native Codex turns and items inside the `messages` response field.
Pages are chronological for display, while `page.cursor` remains opaque.
Clients should virtualize long histories and prepend older pages without
translating item variants.

## Native Agent WebSocket

Open the authenticated provider stream after reading the task metadata:

```text
GET /v1/tasks/{taskId}/agent?afterCursor={providerCursor}
```

Server traffic is Codex App Server JSON-RPC, except for one Codex-only
subscribe-time control frame on the Agent WebSocket:

```json
{
  "kind": "agent.checkpoint",
  "payload": {
    "provider": "codex",
    "cursor": "180"
  }
}
```

That frame is emitted once before retained native replay. It is not JSON-RPC
and must not be treated as a Codex method. All subsequent retained and live
frames remain pure native objects with no PocketPilot payload wrapper and no
Claude SDK translation. Client requests use their own JSON-RPC IDs:

```json
{
  "id": "mobile-42",
  "method": "turn/start",
  "params": {
    "input": [
      {
        "type": "text",
        "text": "Explain the failing test.",
        "text_elements": []
      }
    ]
  }
}
```

PocketPilot binds the task's native `threadId` and rejects a conflicting one.
It currently accepts these client request methods:

- `turn/start`, `turn/steer`, and `turn/interrupt`
- `review/start`, `thread/name/set`, and `thread/compact/start`
- `thread/read`, `thread/turns/list`, and `thread/items/list`
- `model/list`, `collaborationMode/list`, and `permissionProfile/list`
- `account/read`, `account/rateLimits/read`, `skills/list`, `hooks/list`, and
  `mcpServerStatus/list`

Conversation creation, attachment, and task close remain common REST actions;
clients do not send `thread/start`, `thread/resume`, archive, delete, account
login/logout, configuration-write, filesystem, process, plugin, or arbitrary MCP
methods over the task socket.

Turn start, review, compact, steer, and native server-request responses use the
shared P2 task lane. Native interrupt is P1 and invalidates older P2 work before
forwarding. Catalog and history requests are P3 reads outside that lane, but
task and workspace authorization are rechecked around the bridge write. Idle
Codex turns, reviews, and compact operations reserve the same configured
active-task capacity as Claude turns. Rename does not start a turn and does not
reserve capacity.

Codex remote tasks advertise `attachments: false`. Clients must not invent
attachment-bearing `turn/start` input for Codex. Native review, rename, and
compact appear under `capabilities.nativeActions` with exact methods and
availability. Detached review is not supported; only inline review delivery is
forwarded.

Codex advertises `capabilities.historyFilters.includeSystemMessages: false`.
History REST may omit the filter or send `false`; both return native turn/item
rows unchanged. `includeSystemMessages=true` is rejected with
`409 HISTORY_FILTER_NOT_SUPPORTED` before any native history request. Do not
reshape Codex history into Claude system/user/assistant messages.

Readonly status catalogs appear under `capabilities.statusCatalogs`. Codex
advertises `account`, `rateLimits`, `skills`, `hooks`, and `mcpServers`. Those
methods stay on the native Agent WebSocket, remain P3 reads, reject
`account/read` with `refreshToken: true`, authorize optional `cwd`/`cwds`,
inject the task workspace into `skills/list` and `hooks/list` when neither path
is provided, and project path/token/command-safe payloads before delivery.
Matching notifications (`account/updated`, `account/rateLimits/updated`,
`skills/changed`, `hook/started`, `hook/completed`, and
`mcpServer/startupStatus/updated`) are forwarded with the same projection rules.

## Turn lifecycle

Use `turn/start` while the task has no active turn. Codex returns a native turn
and emits `turn/started`. PocketPilot stores the returned turn ID separately as
`activeTurnId`.

Native `review/start` and `thread/compact/start` also require an idle task. They
share the same turn-start capacity reservation and move the task to `executing`
when `turn/started` arrives. While a review or compact turn is active, clients
must not send `turn/steer`.

When a normal turn is active, additional user input uses:

```json
{
  "id": "mobile-43",
  "method": "turn/steer",
  "params": {
    "expectedTurnId": "019...",
    "input": [{ "type": "text", "text": "Focus on the parser." }]
  }
}
```

`expectedTurnId` must equal the task's current native turn ID. There is no
Codex equivalent of Claude priority or `shouldQuery`, so clients must not map
those fields.

Use PocketPilot's task interrupt control for normal UI interruption. It invokes
native `turn/interrupt(threadId, turnId)`. `turn/completed` remains the
authoritative native terminal event and can report `completed`, `interrupted`,
or `failed`. Closing a PocketPilot task unsubscribes/detaches; it does not
archive or delete the Codex thread.

PocketPilot independently projects native lifecycle changes as `task.state`
events on `/v1/events`: executing, awaiting approval, executing after the last
approval resolves, and idle after completion. These control events never wrap
or replace the native Agent frames.

## Streaming and items

A typical text turn emits:

```text
turn/started
item/started
item/agentMessage/delta  (zero or more text deltas)
item/completed           (authoritative final item)
turn/completed           (authoritative final turn)
```

Other native items include reasoning, plans, command execution, file changes,
MCP calls, web search, images, review state, and context compaction. Reduce
deltas by Codex item ID and replace them with `item/completed`; do not animate a
complete item when no native delta was received.

PocketPilot forwards only reviewed conversation notifications. Unknown or
privileged methods are not exposed merely because a newer App Server emits
them.

## Models, reasoning, modes, and permissions

Use native catalogs rather than Claude enums:

- `model/list` returns model IDs, defaults, modalities, service tiers, and each
  model's `supportedReasoningEfforts`.
- `collaborationMode/list` returns the installed Codex collaboration modes.
- `permissionProfile/list` returns native named permission profiles.
- `turn/start` accepts native `model`, `effort`, `collaborationMode`,
  `approvalPolicy`, `permissions`, `sandboxPolicy`, and related sticky fields.

The client should render only values returned by the installed server. It must
not reuse Claude model, effort, or permission-mode schemas.

Claude-only composer/model/effort/permission/approval REST controls return
`TASK_CONTROL_NOT_SUPPORTED` for Codex. PocketPilot also exposes no fixed
Codex slash-command panel: Claude `/clear`, `/compact`, review commands, and
aliases must not be emulated. A new Codex conversation is a native new thread.

## Concurrent server requests

App Server can have several outstanding requests at the same time. PocketPilot
keeps them keyed by native JSON-RPC request ID and routes only to the task that
owns the thread. Forwarded methods are:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

Return the exact method-specific native result using the same request ID. Do
not collapse Codex decisions into a generic allow/deny type. Requests become
stale after native resolution, turn completion, interrupt, close, bridge exit,
workspace revocation, or shutdown.

The unchanged request and response stay on the Agent WebSocket. `/v1/events`
also publishes `approval.requested` with
`{ provider: "codex", requestId, method, params }` for shared task UI. This is
a control projection only and is never inserted into a native frame.

## Workspace authorization

PocketPilot canonicalizes every workspace selected through the common REST API.
For native task requests it validates path-bearing fields such as `cwd`,
`runtimeWorkspaceRoots`, sandbox roots, and attachment paths against that
workspace. Ordinary prompt text is never parsed as a filesystem path.

PocketPilot authorization is not a Codex sandbox. Continue to send native
`sandbox`, `sandboxPolicy`, and permission-profile values appropriate for the
user's selection.

## Reconnect and failure handling

`afterCursor` is outside native frames. On subscribe, Codex emits one
`agent.checkpoint` frame first with `payload.cursor` equal to the latest
retained journal cursor (or `null`). A retained known cursor then replays only
later native frames. A missing, malformed, expired, or evicted cursor replays
the complete retained active turn from its beginning. Beginning a new turn
resets the window; completion, interrupt, close, or revocation clears it.

Clients may store a non-null checkpoint cursor and pass it as `afterCursor` on
the next open. Because checkpoints are subscribe-time only, frames published
after subscribe are not reflected until the next reconnect and a short
re-replay tail is possible. Omitting `afterCursor` still rebuilds from the full
retained window. Discard the pre-disconnect active-turn reducer before applying
replay, do not append replayed text/reasoning deltas to old buffers, and
reconcile completed work from native history. Native thread/turn/item IDs are
not transport cursors.

An App Server process restart creates a new bridge generation. PocketPilot
initializes it, sends `initialized`, and calls `thread/resume` before forwarding
new task work. Pending requests from the failed connection are rejected; their
IDs are never reused as approvals on the new connection.

WebSocket close reasons are stable PocketPilot transport metadata:

| Code | Reason |
| --- | --- |
| 4000 | `SDK_MESSAGE_INVALID` |
| 4003 | `AUTHENTICATION_FAILED` |
| 4004 | `TASK_NOT_FOUND` |
| 4009 | `TASK_SESSION_UNAVAILABLE` |
| 4011 | `SDK_TRANSPORT_FAILED` |

Do not automatically resend a prompt after an uncertain transport failure.
Refresh task state, reconnect without a Codex cursor, rebuild the active-turn
projection, and let native history determine completed state before sending.

## Live verification

The live suite requires a caller-provided absolute workspace and never embeds a
developer path, account, executable path, or credential:

```powershell
$env:CODEX_APP_SERVER_TEST_CWD = "<absolute-workspace-path>"
pnpm test:codex:live
Remove-Item Env:CODEX_APP_SERVER_TEST_CWD
```

Set `CODEX_APP_SERVER_TEST_CWD` (or `POCKETPILOT_CODEX_LIVE_CWD`) to a writable
authorized workspace before running live tests. The suite stays opt-in so
default CI remains hermetic. Live coverage includes readiness probing, readonly
status catalogs (`account`, `rateLimits`, `skills`, `hooks`, `mcpServers`),
thread list filters, rename, fork, archive, unarchive, and delete of disposable
test-created threads only. Set `POCKETPILOT_CODEX_COMMAND` only when a
non-default command or absolute executable path is required. Ordinary
`pnpm test` skips the live suite.
