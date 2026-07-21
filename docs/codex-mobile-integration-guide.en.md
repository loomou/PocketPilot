# PocketPilot Codex Mobile Integration Guide

This guide is the Codex-specific client path for mobile apps that talk only to
PocketPilot's remote `/v1` API. PocketPilot owns the officially installed and
authenticated Codex App Server on the computer. The mobile client must not open
App Server directly and must not translate Codex frames into Claude SDK
messages.

- REST field source of truth: local Swagger `/documentation/` or packaged
  [`dist/openapi/mobile-v1.json`](../dist/openapi/mobile-v1.json)
- Native JSON-RPC field source of truth: the installed Codex App Server schema
- Shared auth, pairing, workspaces, and control-socket rules:
  [General mobile integration guide](./mobile-integration-guide.en.md)
- App Server protocol/lifecycle notes:
  [Codex App Server integration](./codex-app-server-integration.en.md)
- Simplified Chinese equivalent:
  [Codex mobile guide (zh-CN)](./codex-mobile-integration-guide.zh-CN.md)

## Guide map

1. [Transport, auth, and workspace](#1-transport-auth-and-workspace)
2. [Discover readiness and capabilities](#2-discover-readiness-and-capabilities)
3. [Conversation REST lifecycle](#3-conversation-rest-lifecycle)
4. [Agent WebSocket](#4-agent-websocket)
5. [Approvals](#5-approvals)
6. [Reconnect, afterCursor, and checkpoint](#6-reconnect-aftercursor-and-checkpoint)
7. [Recommended state machine](#7-recommended-state-machine)
8. [Errors and recovery](#8-errors-and-recovery)
9. [Claude differences matrix](#9-claude-differences-matrix)
10. [Do / don't](#10-do--dont)

---

## 1. Transport, auth, and workspace

### 1.1 Two sockets, two jobs

| Endpoint | Responsibility | Codex client behavior |
| --- | --- | --- |
| `/v1/events` | PocketPilot control events and task control state | Parse only PocketPilot control envelopes; never look for Codex text or items here |
| `/v1/tasks/{taskId}/agent` | Bidirectional provider-native stream for one task | Native Codex JSON-RPC frames, plus one subscribe-time `agent.checkpoint` control frame before retained replay |

The Agent WebSocket does **not** wrap frames as `{ kind: "sdk", payload }` or
`{ kind: "agent", payload }`. Server traffic is pure Codex App Server JSON-RPC
except for one Codex-only subscribe-time control frame:

```json
{
  "kind": "agent.checkpoint",
  "payload": {
    "provider": "codex",
    "cursor": "180"
  }
}
```

That frame is emitted once before retained native replay. Every later server
frame is one native Codex JSON object. Every client frame must be either an
allowed native Codex request or a response to a native server request.

PocketPilot starts and initializes App Server over stdio. Mobile clients never
send `initialize`, `initialized`, `thread/start`, `thread/resume`, archive,
delete, or other conversation lifecycle mutations over the Agent WebSocket.
Those lifecycle actions use REST.

### 1.2 Keep every identity separate

| Identifier | Owner | Purpose |
| --- | --- | --- |
| `taskId` | PocketPilot | REST, Agent WebSocket, task state, reconnect, and routing |
| `threadId` / `nativeConversationId` | Codex | One persistent conversation branch; the REST `conversationId` path parameter is this value |
| `sessionId` / `nativeSessionId` | Codex | Root identity of a Codex session tree; forks may share it |
| `turnId` / `activeTurnId` | Codex / PocketPilot | One currently executing user request |
| `itemId` | Codex | A user message, agent message, reasoning, command, file change, or tool item |
| JSON-RPC `id` | Requesting peer | Correlates one request and response, including approval server requests |
| `afterCursor` | PocketPilot transport | Replay position for the Agent stream; not a Codex thread, turn, or item ID |
| REST `operationId` | Mobile client | HTTP mutation idempotency only; never put it inside a native Codex frame |

`taskId` is neither `threadId` nor `sessionId`. A Codex thread can be attached to
PocketPilot tasks at different times, and one task carries multiple consecutive
turns.

### 1.3 Authentication

Except for public pairing bootstrap routes, every `/v1` request carries:

```http
Authorization: Bearer <accessToken>
```

Use the same `Authorization` header during both WebSocket handshakes. Never put
credentials in a URL, query string, log, analytics event, crash report, or
screenshot. When converting the QR `baseUrl` to a WebSocket URL, map `http` to
`ws` and `https` to `wss`.

Reuse pairing, credential refresh, and device revocation from the
[general mobile guide](./mobile-integration-guide.en.md). Codex does not change
PocketPilot device authentication.

### 1.4 Select an authorized workspace

```http
GET /v1/workspaces
```

```json
{
  "workspaceRoots": [
    "D:\\Projects\\demo",
    "D:\\Projects\\another-repo"
  ]
}
```

Conversation listing, creation, attachment, lifecycle mutations, and Agent
requests all require an authorized workspace. Let the user select an exact
string returned by this endpoint. Do not concatenate paths, normalize them
independently, or rewrite path separators on the client. An empty array means
the computer user has not authorized any root yet; mobile cannot invent one.

For create/attach/fork and confirm-gated mutations, the body also requires
`workspaceRiskAccepted: true`. Authorized roots constrain initial `cwd`; they
are not a filesystem sandbox for Codex tools.

---

## 2. Discover readiness and capabilities

Call these routes before presenting Codex as available:

```http
GET /v1/providers
GET /v1/providers/codex/capabilities
```

Show Codex only when `status` is `available`. Discovery and capabilities
refresh server-side readiness with a short TTL (about 30s). Unavailable
providers stay listed with a stable `reasonCode` such as:

| `status` | Typical `reasonCode` | Client handling |
| --- | --- | --- |
| `available` | omitted | Offer Codex in provider selection |
| `not_installed` | `CODEX_COMMAND_NOT_FOUND` | Tell the user to install Codex CLI on the computer |
| `unsupported_version` | `CODEX_APP_SERVER_VERSION_UNSUPPORTED` | Tell the user to upgrade/downgrade to a supported App Server |
| `unhealthy` | `CODEX_APP_SERVER_PROBE_FAILED` | Retry discovery later; do not invent a local path diagnosis |
| `disabled` | stable configured reason when present | Hide execution controls; keep discovery honest |

Those responses never include install paths, credentials, env dumps, raw stderr,
or stack traces. Do not infer availability from a local executable path or a
client-owned provider list. Re-read providers/capabilities after the host may
have installed, upgraded, or removed Codex.

### 2.1 Closed capability shape

A successful Codex capability snapshot looks like this. Always trust the values
returned by the server for the installed protocol version:

```json
{
  "id": "codex",
  "displayName": "Codex CLI",
  "status": "available",
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
    "statusCatalogs": {
      "account": true,
      "hooks": true,
      "mcpServers": true,
      "rateLimits": true,
      "skills": true
    },
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

Closed objects the client must treat as exhaustive for product UI:

| Capability object | Closed keys | Notes |
| --- | --- | --- |
| `historyFilters` | `includeSystemMessages` | Codex publishes `false` |
| `nativeActions` | `review`, `rename`, `compact` only | Unknown action keys are dropped server-side |
| `statusCatalogs` | `account`, `rateLimits`, `skills`, `hooks`, `mcpServers` | Boolean presence only |
| `threadManagement` | `archive`, `delete`, `fork`, `includeArchived`, `search`, `unarchive` | Boolean presence only |
| `attachments` | boolean | Codex is `false`; do not invent attachment input |

Gate every UI control on these closed flags. Capability metadata is descriptive
only; execution stays on the reviewed REST or native Agent WebSocket surface.

---

## 3. Conversation REST lifecycle

All conversation REST routes are Bearer-protected and provider-scoped under
`/v1/providers/codex/...`. Generate request/response types from OpenAPI; this
section owns workflow, not every schema field.

### 3.1 List threads

```http
GET /v1/providers/codex/conversations?workspace=<urlEncodedWorkspace>&limit=50&includeArchived=true&searchTerm=review
```

Optional query parameters:

| Query | When to send | Behavior |
| --- | --- | --- |
| `cursor` | Pagination | Opaque; return unchanged while `page.hasMore` is true |
| `limit` | Page size | At most 50 |
| `includeArchived=true` | Only when `threadManagement.includeArchived` is true | Forwarded as native `archived: true` |
| `searchTerm` | Only when `threadManagement.search` is true | Forwarded unchanged after trim |

Response field is `conversations`, not `items`:

```json
{
  "conversations": [
    {
      "id": "thr_019abc",
      "sessionId": "sess_019abc",
      "cwd": "D:\\Projects\\demo",
      "turns": []
    }
  ],
  "page": {
    "cursor": null,
    "hasMore": false
  }
}
```

Each entry is a native Codex thread and may gain fields. Preserve unknown
fields. PocketPilot requests CLI, VS Code, and App Server thread sources, then
returns only threads authorized for the selected workspace.

### 3.2 Read history

```http
GET /v1/providers/codex/conversations/{threadId}?workspace=<urlEncodedWorkspace>&limit=50
```

Outer field is `messages`, but entries are native Codex turns/items:

```json
{
  "messages": [
    {
      "id": "turn_019abc",
      "status": "completed",
      "items": [
        {
          "id": "item_019abc",
          "type": "agentMessage"
        }
      ]
    }
  ],
  "page": {
    "cursor": "next-page-token",
    "hasMore": true
  }
}
```

Rules:

- Load the latest page first (omit `cursor`), then prepend older pages with
  `page.cursor`.
- Virtualize long histories. Deduplicate by turn/item IDs when the same content
  also arrives live.
- Codex advertises `historyFilters.includeSystemMessages: false`. Omit the
  query or send `includeSystemMessages=false`. Sending `true` is rejected with
  `409 HISTORY_FILTER_NOT_SUPPORTED` **before** any native history request.
- Never reconstruct historical items as a new `turn/start` input.

### 3.3 Attach an existing conversation

```http
POST /v1/providers/codex/conversations/{threadId}/attach
Content-Type: application/json

{
  "operationId": "0c4cde63-e7a6-4a2d-a2d5-2c3a6bb16f19",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

Response is a task operation result with a non-null `task`:

```json
{
  "action": "attached",
  "task": {
    "id": "8d0d6d3b-4dc4-4c65-95e3-0a6d47a6f812",
    "provider": "codex",
    "state": "idle",
    "initialCwd": "D:\\Projects\\demo",
    "nativeConversationId": "thr_019abc",
    "nativeSessionId": "sess_019abc",
    "nativeProtocolVersion": "codex-app-server@0.144",
    "activeTurnId": null,
    "model": null,
    "permissionMode": null,
    "sdkSessionId": null,
    "origin": "agent-conversation",
    "createdAt": 1780000000000,
    "updatedAt": 1780000000000,
    "interruptedAt": null,
    "terminalAt": null
  }
}
```

If the thread is already bound to a non-terminal PocketPilot task, the backend
reuses that task. Always use the returned `task.id`.

### 3.4 Create an empty conversation

```http
POST /v1/providers/codex/conversations
Content-Type: application/json

{
  "operationId": "d1b3a5f1-7537-440d-a64a-5c4f2a8de8a7",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

PocketPilot calls native `thread/start` and returns `{ action: "created", task }`
with `taskId`, `nativeConversationId`, and `nativeSessionId`. This does **not**
submit a user prompt. Send the first user message with `turn/start` after the
Agent WebSocket opens.

### 3.5 Fork

```http
POST /v1/providers/codex/conversations/{threadId}/fork
Content-Type: application/json

{
  "operationId": "00000000-0000-4000-8000-000000000040",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

Only when `threadManagement.fork` is true. Fork creates a new native thread and
returns `{ action: "forked", task }` bound to that **new** conversation. Continue
on `/v1/tasks/{taskId}/agent` for the returned task.

### 3.6 Archive / unarchive

```http
POST /v1/providers/codex/conversations/{threadId}/archive
POST /v1/providers/codex/conversations/{threadId}/unarchive
```

| Action | Capability | Confirm | Result | Task effect |
| --- | --- | --- | --- | --- |
| Archive | `threadManagement.archive` | Required `confirm: true` | `{ action: "archived", task: null }` | Does **not** auto-close a bound task |
| Unarchive | `threadManagement.unarchive` | Not required | `{ action: "unarchived", task: null }` | Does not create a local task; attach again before Agent WS |

Missing or false `confirm` on archive returns `409 CONFIRMATION_REQUIRED`.

### 3.7 Delete

```http
POST /v1/providers/codex/conversations/{threadId}/delete
Content-Type: application/json

{
  "confirm": true,
  "operationId": "00000000-0000-4000-8000-000000000041",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

Only when `threadManagement.delete` is true. Delete requires `confirm: true` or
returns `409 CONFIRMATION_REQUIRED`. Success returns
`{ action: "deleted", task: null }` and terminates any local non-terminal task
bound to that conversation **after** native delete succeeds. Treat delete as
irreversible from the mobile client.

### 3.8 Capability gating for lifecycle UI

Render fork/archive/unarchive/delete controls only when the matching
`threadManagement` boolean is true. Claude currently advertises all of those
flags as `false`. Do not invent alternative REST mutation routes or send
archive/delete over the Agent WebSocket.

---

## 4. Agent WebSocket

### 4.1 Open after attach/create

```text
GET /v1/tasks/{taskId}/agent?afterCursor=<optional-opaque-cursor>
```

Handshake uses the same Bearer access credential. Recommended order:

1. Attach or create → save `task.id`, `nativeConversationId`, `nativeSessionId`.
2. Optionally load latest history for display.
3. Open `/v1/events` and subscribe to `taskId` for control state.
4. Open `/v1/tasks/{taskId}/agent` (optionally with `afterCursor`).
5. Discriminate the first server frame: `agent.checkpoint` vs native JSON-RPC.
6. Apply retained native frames, then live native frames.
7. Only then send client methods such as `turn/start` or catalog reads.

The server installs the native subscriber before activation so early retained or
init traffic is not lost.

### 4.2 Allowed client methods

PocketPilot currently accepts these client request methods on the Codex Agent
socket:

| Group | Methods | Lane notes |
| --- | --- | --- |
| Turn start | `turn/start`, `review/start`, `thread/compact/start` | Idle only; reserve shared capacity; start active-turn retention |
| Active turn | `turn/steer`, `turn/interrupt` | Steer only normal turns; interrupt is P1 |
| Rename | `thread/name/set` | P2, does not start a turn, no capacity reservation |
| History reads | `thread/read`, `thread/turns/list`, `thread/items/list` | P3 |
| Catalogs | `model/list`, `collaborationMode/list`, `permissionProfile/list` | P3 |
| Status catalogs | `account/read`, `account/rateLimits/read`, `skills/list`, `hooks/list`, `mcpServerStatus/list` | P3; path-safe projection |

Conversation create/attach/fork/archive/unarchive/delete stay on REST. Do not
send `thread/start`, `thread/resume`, archive, delete, account login/logout,
configuration writes, filesystem/process RPCs, plugin install, arbitrary MCP
calls, detached review, or unknown privileged methods on this socket.

### 4.3 Native actions

Read `capabilities.nativeActions` for exact methods:

| Action key | Method | Availability | Starts turn | Notes |
| --- | --- | --- | --- | --- |
| `review` | `review/start` | `idle` | yes | Only `delivery` omitted/`null`/`"inline"`; reject `detached` |
| `rename` | `thread/name/set` | `always` | no | Non-empty bounded `name`; binds to current task thread |
| `compact` | `thread/compact/start` | `idle` | yes | Binds only to current task thread |

While a review or compact turn is active, reject local `turn/steer` UI; interrupt
against the current `activeTurnId` remains allowed. Runtime-only turn kind is
never persisted in task rows.

### 4.4 Status catalogs

Read `capabilities.statusCatalogs`. Codex currently advertises:

- `account` → `account/read`
- `rateLimits` → `account/rateLimits/read`
- `skills` → `skills/list`
- `hooks` → `hooks/list`
- `mcpServers` → `mcpServerStatus/list`

Client rules:

- Reject or never send `account/read` with `refreshToken: true`.
- Skills/hooks accept official `cwds[]`; a legacy single `cwd` is rewritten
  server-side. When no path root is provided, PocketPilot injects the current
  authorized task workspace and authorizes every requested root under it.
- Responses and allowlisted notifications are projected path-safe: absolute
  paths, email, refresh tokens, hook commands, and raw env/command material are
  dropped before delivery.
- Allowlisted notifications: `account/updated`, `account/rateLimits/updated`,
  `skills/changed`, `hook/started`, `hook/completed`, and
  `mcpServer/startupStatus/updated`.
- Do not invent REST mutation routes for status catalogs.

### 4.5 Frame format

Client request:

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

Server notification (example):

```json
{
  "method": "turn/started",
  "params": {
    "turn": {
      "id": "turn_019xyz",
      "status": "inProgress"
    }
  }
}
```

PocketPilot may remap duplicate client JSON-RPC IDs privately across tasks and
restore the client's original ID only on the owning task stream. Treat
`item/agentMessage/delta` plus later `item/completed` as the normal text path.
Preserve unknown methods/fields; do not map Codex items into Claude
`assistant` / `tool_use` / `stream_event` shapes.

### 4.6 Turn lifecycle summary

```text
idle
  --turn/start | review/start | thread/compact/start--> executing
  --native server request--> awaiting_approval (task state via /v1/events)
  --turn/completed | interrupt cleanup--> idle
```

- Authoritative active turn ID comes from `turn/started`, not from the request
  response alone.
- While `activeTurnId` is set for a normal turn, later user input uses
  `turn/steer` with that expected turn ID.
- Interrupt is allowed for normal, review, and compact turns against the current
  active turn ID.
- Claude-only REST composer/model/mode/effort/approval routes return
  `409 TASK_CONTROL_NOT_SUPPORTED` for Codex tasks. Use native catalogs and
  native approval responses instead.
- Codex remote tasks advertise `attachments: false`. Do not invent attachment
  input on remote `turn/start`.

---

## 5. Approvals

Codex approvals are native App Server server-requests on the Agent WebSocket.
Resolve them by returning a native JSON-RPC **result** (or error) with the same
request `id`. Do not call Claude's
`POST /v1/tasks/{taskId}/approvals/{requestId}` for Codex.

PocketPilot may also project a metadata-only control event on `/v1/events`:

```json
{
  "kind": "approval.requested",
  "payload": {
    "provider": "codex",
    "requestId": "42",
    "method": "item/commandExecution/requestApproval",
    "params": {}
  }
}
```

Use that projection for task UI/state only. The answer still travels as the
unchanged native response on the Agent WebSocket from the owning device and
bridge generation. A response for a cleared, prior-generation, or other-device
request returns `409 STALE_APPROVAL`.

Result schemas differ by method. Generate production types from the current App
Server schema and preserve unrecognized fields. Do not collapse approvals into
`{ allowed: true }` or Claude `behavior: "allow"`.

---

## 6. Reconnect, afterCursor, and checkpoint

`afterCursor` is PocketPilot transport metadata, not a field inside Codex
JSON-RPC frames:

```text
GET /v1/tasks/{taskId}/agent?afterCursor=<opaque-cursor>
```

### 6.1 Subscribe-time checkpoint rules

On each successful Codex Agent subscribe, before any retained native frames, the
socket emits exactly one out-of-band control frame:

```json
{
  "kind": "agent.checkpoint",
  "payload": {
    "provider": "codex",
    "cursor": "180"
  }
}
```

| Rule | Detail |
| --- | --- |
| Cadence | Subscribe-time only; not after every native publish |
| `payload.cursor` | Latest retained journal cursor at emit time, or `null` when no window exists |
| Discrimination | `kind === "agent.checkpoint"` and no `jsonrpc` → control; later frames are pure native |
| Known cursor | Replays only native frames after that cursor |
| Missing / invalid / unknown / evicted cursor | Replays the full retained active turn |
| Retention window | Active turn only; newer turn start clears prior window; complete/interrupt/close/revoke clears it |
| Lag honesty | Checkpoint may lag mid-turn; a short re-replay tail after reconnect is correct |

Claude does **not** emit `agent.checkpoint` on this surface.

### 6.2 Recommended reconnect flow

1. Refresh task metadata if the disconnect reason is unclear.
2. Reopen `/v1/tasks/{taskId}/agent` either:
   - without `afterCursor` and rebuild the full active-turn projection, or
   - with `afterCursor=lastCheckpoint` when non-null and accept possible short
     re-replay of frames published after that checkpoint.
3. On open, if the first frame is `agent.checkpoint`, store `payload.cursor` as
   `lastCheckpoint` when non-null.
4. Apply retained and live **native** frames only; skip non-native control
   frames when building transcript projections.
5. Do not append replayed text/reasoning deltas onto pre-disconnect partial
   buffers without resetting those buffers first.
6. Never substitute `threadId`, `turnId`, `itemId`, or a message UUID for the
   transport cursor. Reconcile completed work from native history when needed.

### 6.3 App Server restart

An App Server process restart creates a new bridge generation. PocketPilot
initializes the new internal connection and resumes attached threads before
forwarding new work. Approval request IDs from the old generation are not
transferred; old pending requests become `STALE_APPROVAL`.

### 6.4 Control socket reconnect

`/v1/events` is independent. Keep a separate control `afterCursor` per `taskId`.
Control replay never carries Codex items. If control replay reports
`EVENT_REPLAY_STORAGE_LIMIT_REACHED`, continue live delivery and refresh task
state from REST because the gap is not fully replayable.

---

## 7. Recommended state machine

```text
select provider (status === available)
  -> read capabilities (closed objects)
  -> select authorized workspace
  -> GET conversations (optional includeArchived / searchTerm)
  -> select thread / create conversation / fork
  -> attach or create; save taskId + threadId + sessionId
  -> GET latest history page (no includeSystemMessages=true)
  -> open /v1/events and subscribe(taskId)
  -> open /v1/tasks/{taskId}/agent[?afterCursor]
  -> first frame: agent.checkpoint? store cursor : treat as native
  -> apply retained native frames, then live frames
  -> idle: turn/start | review/start | thread/compact/start | thread/name/set | catalogs
  -> executing: reduce native notifications and items by itemId/turnId
  -> normal active input: turn/steer(expectedTurnId)
  -> review/compact active: interrupt only (no steer)
  -> approval server request: return native result with same JSON-RPC id
  -> turn/completed or interrupt cleanup: clear activeTurnId -> idle
  -> disconnect:
       refresh task if needed
       discard partial active projection buffers
       reconnect with lastCheckpoint or full-window fallback
       re-apply checkpoint + retained/live native frames
  -> archive/unarchive/delete: REST only; respect confirm + task effects
```

Use `taskId` as the transport and runtime-cache key. Use `threadId` as the Codex
conversation key. The UI may present one conversation, but the client must not
merge those identifiers. Model, effort, mode, and permission choices affect later
native turns without creating a new thread or task.

---

## 8. Errors and recovery

### 8.1 Common REST / task errors

Branch on stable `{ code, message }`. Present `message` only as user-safe
context.

| Error code | Meaning | Recommended handling |
| --- | --- | --- |
| `AGENT_PROVIDER_NOT_FOUND` | Unknown provider id | Fix client routing; re-read `/v1/providers` |
| `AGENT_PROVIDER_UNAVAILABLE` | Codex is registered but not executable | Refresh provider state; direct user to the computer |
| `CODEX_THREAD_NOT_FOUND` | Thread missing, unreadable, or outside workspace | Remove stale row; reload conversation list |
| `CODEX_HISTORY_UNAVAILABLE` | Native history temporarily unavailable | Keep current UI; retry history later; never send history as a prompt |
| `HISTORY_FILTER_NOT_SUPPORTED` | Unsupported history filter (for example `includeSystemMessages=true`) | Drop the filter; Codex only accepts omit/`false` |
| `HISTORY_CURSOR_STALE` | History cursor no longer valid | Reload latest page without cursor |
| `CONFIRMATION_REQUIRED` | Archive/delete missing `confirm: true` | Show explicit confirm UI, then retry with `confirm: true` |
| `WORKSPACE_NOT_AUTHORIZED` | Workspace or path outside authorized roots | Reload `/v1/workspaces`; stop the request |
| `WORKSPACE_SCOPE_RISK_NOT_ACCEPTED` | Create/attach body omitted risk acceptance | Obtain explicit acceptance and issue a new operation |
| `TASK_BUSY` | Turn precondition stale or state rejects the action | Refresh task and active-turn state |
| `CONCURRENT_TASK_LIMIT_REACHED` | Idle turn would exceed shared Claude/Codex capacity | Keep composer input; retry after another active task becomes idle |
| `TASK_OPERATION_SUPERSEDED` | P0/P1 invalidated an older queued operation | Drop that old operation; do not auto-retry it on the new generation |
| `TASK_CONTROL_NOT_SUPPORTED` | Claude-only REST control used on a Codex task | Use Codex native catalogs, turn parameters, or native approval responses |
| `STALE_APPROVAL` | Server request no longer pending for this device/generation | Remove local approval UI; do not replay |
| `CODEX_REQUEST_NOT_ALLOWED` | Method/params denied (detached review, empty rename, unauthorized path, etc.) | Fix client payload; do not forward inventively |
| `CODEX_APP_SERVER_UNAVAILABLE` | App Server unavailable or invalid contract | Show provider unavailability; wait for reconnect |
| `TASK_NOT_FOUND` / `TASK_TERMINAL` / `TASK_SESSION_UNAVAILABLE` | Runtime missing or unusable | Reattach or create; stop reconnect loops on terminal |

### 8.2 Agent WebSocket close codes

| Code | Reason | Handling |
| ---: | --- | --- |
| `4000` | `SDK_MESSAGE_INVALID` | Invalid JSON, binary frame, or non-allowlisted method; fix client, do not resend unchanged |
| `4003` | `AUTHENTICATION_FAILED` | Refresh credentials or pair again |
| `4004` | `TASK_NOT_FOUND` | Fetch tasks again or reattach the native thread |
| `4009` | `TASK_SESSION_UNAVAILABLE` | Refresh task state; interrupted/terminal/revoked tasks cannot open this stream |
| `4011` | `SDK_TRANSPORT_FAILED` | Provider bridge failed; exponential backoff with jitter, then reconnect |

The `SDK_*` wording in close reasons is retained for transport compatibility. For
a Codex task it describes the provider-native transport, not a Claude SDK
message.

---

## 9. Claude differences matrix

| Area | Codex | Claude |
| --- | --- | --- |
| Agent WebSocket frame | Codex App Server JSON-RPC-style object | Raw Claude Agent SDK `SDKUserMessage` / `SDKMessage` |
| First subscribe frame | May be `agent.checkpoint`, then pure native | No `agent.checkpoint`; raw SDK frames only |
| Initialization | PocketPilot handles App Server init internally | PocketPilot creates or resumes the SDK Query internally |
| History rows | Native turns/items under REST `messages` | SDK `SessionMessage` history |
| `historyFilters.includeSystemMessages` | `false`; `true` → `HISTORY_FILTER_NOT_SUPPORTED` | `true`; filter honored |
| Streaming text | `item/agentMessage/delta` + `item/completed` | `stream_event`, `content_block_delta`, and related messages |
| Active input | `turn/steer(expectedTurnId)` for normal turns | Native Claude SDK message behavior |
| Approvals | Native server requests by JSON-RPC ID; `/v1/events` adds provider-tagged projection | Claude SDK `PermissionResult` via approval REST |
| Model / mode / effort | Native `model/list`, collaboration mode, permission profile catalogs | Task composer-options + model/mode/effort REST |
| Native actions | Closed `review` / `rename` / `compact` | Empty until a reviewed surface lands |
| Status catalogs | Closed account/rateLimits/skills/hooks/mcpServers | Empty / false until reviewed |
| Thread management | Closed archive/delete/fork/includeArchived/search/unarchive | All false currently |
| Attachments | `false` | Provider-specific; do not assume Codex supports them |
| Identity | `taskId` ≠ Codex `threadId` | `taskId` ≠ Claude `sdkSessionId` |

Read `task.provider` and `nativeProtocolVersion` before selecting a codec. Never
infer the provider from a path, history shape, or a message `type` member.

---

## 10. Do / don't

### Do

- Pair once, then use Bearer access on every protected REST and WebSocket call.
- Discover readiness and closed capabilities before rendering Codex controls.
- Keep `taskId`, `threadId`, `turnId`, item IDs, JSON-RPC IDs, REST
  `operationId`, and transport `afterCursor` in separate typed stores.
- Load latest history, virtualize, and prepend older pages.
- Open control + Agent sockets after attach/create; handle subscribe-time
  `agent.checkpoint` before native replay.
- Send only allowlisted native methods; answer approvals natively on the Agent
  socket.
- Gate fork/archive/unarchive/delete and native actions on capability flags.
- Require explicit `confirm: true` for archive and delete.
- Reconnect with last checkpoint or full-window fallback; accept short re-replay.
- Branch recovery on stable error codes and WebSocket close codes.

### Don't

- Don't connect directly to Codex App Server from the mobile device.
- Don't wrap native frames or invent `{ kind: "codex", payload }` envelopes
  beyond the single reviewed `agent.checkpoint`.
- Don't send `initialize`, `thread/start`, `thread/resume`, archive, or delete
  over the Agent WebSocket.
- Don't send `includeSystemMessages=true` for Codex history.
- Don't call Claude composer/model/mode/effort/approval REST for Codex tasks.
- Don't invent attachments, detached review, open-ended action catalogs, or
  unreviewed status-mutation REST routes.
- Don't treat archive as auto-close for bound tasks.
- Don't substitute native IDs for PocketPilot transport cursors.
- Don't put credentials, prompts, tool inputs, absolute host paths, or raw
  process diagnostics in logs/analytics.
- Don't assume every server frame is pure native without first checking for the
  subscribe-time checkpoint exception.

---

## Complete request sequence

Shortest successful flow for an existing thread:

```text
1. GET /v1/providers
2. GET /v1/providers/codex/capabilities
3. GET /v1/workspaces
4. GET /v1/providers/codex/conversations?workspace=...
5. GET /v1/providers/codex/conversations/{threadId}?workspace=...&limit=50
6. POST /v1/providers/codex/conversations/{threadId}/attach
7. Save task.id, task.nativeConversationId, and task.nativeSessionId
8. Open /v1/events and subscribe(taskId)
9. Open /v1/tasks/{taskId}/agent
10. Handle agent.checkpoint (if present), then retained/live native frames
11. Send turn/start
12. Reduce deltas and item/completed by itemId
13. Store activeTurnId from turn/started
14. Use turn/steer while a normal activeTurnId exists
15. Clear activeTurnId and refresh history after turn/completed
```

For a new thread, replace steps 5–6 with
`POST /v1/providers/codex/conversations`. Do not send a placeholder prompt
merely to create an empty conversation UI.

---

## References and verification

- [PocketPilot mobile OpenAPI artifact](../dist/openapi/mobile-v1.json)
- [Codex App Server provider-native contract](./codex-app-server-integration.en.md)
- [General mobile integration guide](./mobile-integration-guide.en.md)
- [OpenAI Codex App Server documentation](https://learn.chatgpt.com/docs/app-server.md)
- [Codex App Server source](https://github.com/openai/codex/tree/main/codex-rs/app-server)

The backend live suite requires a caller-provided workspace. Never commit a
developer-specific absolute path to the client or repository:

```powershell
$env:CODEX_APP_SERVER_TEST_CWD = "<absolute-workspace-path>"
pnpm test:codex:live
Remove-Item Env:CODEX_APP_SERVER_TEST_CWD
```

Live coverage includes readiness discovery, readonly status catalogs
(`account` / `rateLimits` / `skills` / `hooks` / `mcpServers`), rename, list
filters, and fork+cleanup of disposable threads only. Normal `pnpm test` does
not start Codex App Server. Mobile integration testing must use a running
PocketPilot `/v1` service and its paired-device credentials; it must not bypass
PocketPilot by connecting directly to the local App Server.
