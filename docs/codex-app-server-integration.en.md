# Codex App Server Integration

This document defines how a PocketPilot client integrates with the `codex`
provider. It describes protocol and lifecycle behavior, not a mobile framework
or UI implementation.

PocketPilot controls the locally installed official Codex App Server over its
stdio JSONL transport. App Server is never exposed directly to the LAN. The
authenticated PocketPilot API remains the only remote boundary.

## Provider discovery

Read `GET /v1/providers` before showing Codex as available. Then read
`GET /v1/providers/codex/capabilities` and select the codec identified by:

```json
{
  "id": "codex",
  "status": "available",
  "protocolVersion": "codex-app-server@0.144",
  "capabilities": {
    "activeTurnSteering": true,
    "approvals": true,
    "attachments": true,
    "effort": true,
    "historyPagination": "cursor",
    "interrupt": true,
    "modes": true,
    "models": true,
    "newConversation": true,
    "resumeConversation": true,
    "streamProtocol": "codex-app-server-json-rpc"
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
```

List requests include Codex CLI, VS Code, and App Server thread sources. Rows
are native Codex thread objects inside the common page envelope:

```json
{
  "items": [
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

History uses native Codex turns and items. Pages are chronological for display,
while `page.cursor` remains opaque. Clients should virtualize long histories
and prepend older pages without translating item variants.

## Native Agent WebSocket

Open the authenticated provider stream after reading the task metadata:

```text
GET /v1/tasks/{taskId}/agent?afterCursor={providerCursor}
```

Every frame is a Codex App Server JSON-RPC object. There is no PocketPilot
payload wrapper and no Claude SDK translation. Client requests use their own
JSON-RPC IDs:

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
- `thread/read`, `thread/turns/list`, and `thread/items/list`
- `model/list`, `collaborationMode/list`, and `permissionProfile/list`

Conversation creation, attachment, and task close remain common REST actions;
clients do not send `thread/start`, `thread/resume`, archive, delete, account,
configuration-write, filesystem, process, plugin, or arbitrary MCP methods over
the task socket.

## Turn lifecycle

Use `turn/start` while the task has no active turn. Codex returns a native turn
and emits `turn/started`. PocketPilot stores the returned turn ID separately as
`activeTurnId`.

When a turn is active, additional user input uses:

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

## Workspace authorization

PocketPilot canonicalizes every workspace selected through the common REST API.
For native task requests it validates path-bearing fields such as `cwd`,
`runtimeWorkspaceRoots`, sandbox roots, and attachment paths against that
workspace. Ordinary prompt text is never parsed as a filesystem path.

PocketPilot authorization is not a Codex sandbox. Continue to send native
`sandbox`, `sandboxPolicy`, and permission-profile values appropriate for the
user's selection.

## Reconnect and failure handling

`afterCursor` is outside native frames. A known cursor replays later retained
frames before live delivery. A missing, malformed, expired, or evicted cursor
replays the retained window from its beginning. Keep the cursor in transport
state, not as a Codex thread, turn, or item ID.

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
Refresh task state, reconnect with the last cursor, and let native history and
turn state determine the next action.

## Live verification

The live suite requires a caller-provided absolute workspace and never embeds a
developer path, account, executable path, or credential:

```powershell
$env:CODEX_APP_SERVER_TEST_CWD = "<absolute-workspace-path>"
pnpm test:codex:live
Remove-Item Env:CODEX_APP_SERVER_TEST_CWD
```

Set `POCKETPILOT_CODEX_COMMAND` only when a non-default command or absolute
executable path is required. Ordinary `pnpm test` skips the live suite.
