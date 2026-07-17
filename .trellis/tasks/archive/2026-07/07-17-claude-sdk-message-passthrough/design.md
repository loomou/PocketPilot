# Technical Design — Claude SDK Message Passthrough

## Design Summary

PocketPilot will expose two deliberately separate remote protocols:

```text
Remote SDK client                         Computer
────────────────────────────────────────────────────────────────────
SDKUserMessage JSON ── task SDK WS ──> ClaudeSdkInputStream ──> Query
SDKMessage JSON     <── task SDK WS ── ClaudeSdkSession.events() <──┘

task/control request ───── HTTP ─────> TaskManager / approval lifecycle
task/control event   <─ control WS ─── TaskEventJournal control channel
```

The task SDK WebSocket is a transparent JSON transport for the pinned Claude
Agent SDK types. PocketPilot authentication, task selection, replay lookup, and
control events remain outside those JSON bodies.

## Decisions

- Add `GET /v1/tasks/:taskId/sdk` as an authenticated, task-specific,
  bidirectional WebSocket.
- Client text frames are raw `SDKUserMessage` objects. Server text frames are
  raw `SDKMessage` objects.
- Keep `GET /v1/events` as the PocketPilot control WebSocket, but remove SDK
  conversation messages from it.
- Keep task creation, lifecycle controls, model/permission changes, and
  approval decisions on authenticated HTTP routes.
- Update `/v1` directly. Do not add `/v2` or retain the normalized SDK event
  compatibility layer.
- Use SDK message UUIDs only as optional reconnect anchors because the SDK type
  owns their optionality. Do not introduce a PocketPilot cursor or operation ID
  in raw SDK frames.
- Proxy the complete serializable `CanUseTool` callback contract and complete
  `PermissionResult`; retain `AbortSignal` only on the computer.

## Public Protocol

### Raw SDK WebSocket

```http
GET /v1/tasks/{taskId}/sdk?afterUuid={optional-sdk-message-uuid}
Authorization: Bearer <opaque-access-credential>
Upgrade: websocket
```

The route path selects the PocketPilot task. The Bearer credential selects and
authenticates the device. Neither value is copied into SDK message bodies.

Client frames contain exactly one JSON-serialized `SDKUserMessage`. The
transport accepts the same SDK-required and SDK-optional fields and forwards
the original parsed object. It does not accept PocketPilot subscribe/control
frames on this socket.

Server frames contain exactly one JSON-serialized `SDKMessage` yielded by the
task's Query. They have no outer `event`, `kind`, `payload`, cursor, PocketPilot
task ID, or PocketPilot timestamp.

WebSocket failures use close status/reason rather than a synthetic JSON error
frame on the SDK stream:

| Condition | Behavior |
| --- | --- |
| Missing/invalid/revoked access credential | Close `4003`; register no task subscription. |
| Frame is not valid JSON or lacks the SDK user-message top-level contract | Close `4000` with reason `SDK_MESSAGE_INVALID`; submit nothing. |
| Task does not exist | Close `4004` with reason `TASK_NOT_FOUND`. |
| Task is interrupted, terminal, or its SDK input is closed | Close `4009` with reason `TASK_SESSION_UNAVAILABLE`. |
| Unexpected SDK transport failure | Close `4011` with reason `SDK_TRANSPORT_FAILED`; report safe task state separately. |

These private close codes are constants owned by the SDK route and are included
in the OpenAPI WebSocket extension. Close reasons contain only stable codes,
never raw SDK or internal exception text.

### Control WebSocket

`GET /v1/events` retains the current authenticated subscription protocol and
PocketPilot envelope because it is explicitly the PocketPilot control channel.
It may deliver task state, approval requests, replay-limit notifications, and
other PocketPilot control events. It must never deliver an SDK conversation
message.

The approval request payload preserves SDK callback names and values:

```ts
type SerializableCanUseToolRequest = {
  toolName: Parameters<CanUseTool>[0];
  input: Parameters<CanUseTool>[1];
  options: Omit<Parameters<CanUseTool>[2], "signal">;
};
```

The outer control-event envelope identifies this as a PocketPilot lifecycle
notification; the request object inside is the SDK callback contract, not a
renamed or reduced mobile projection.

### Approval Response

The existing approval HTTP operation keeps its PocketPilot `operationId` for
idempotency but carries a complete SDK result:

```ts
{
  operationId: string;
  result: PermissionResult;
}
```

The path parameter uses the SDK callback `requestId`. The task manager returns
`result` unchanged to the waiting `CanUseTool` callback. An SDK abort, task
interrupt, task close, replacement request, or Agent shutdown still cancels the
local deferred callback and never serializes `AbortSignal`.

## SDK Boundary

`ClaudeSdkSession.events()` changes from
`AsyncGenerator<NormalizedClaudeSdkEvent>` to `AsyncGenerator<SDKMessage>` and
yields every Query message unchanged. It may observe `session_id` before
yielding but must not clone, filter, rename, or project the message.

`normalizeSdkMessage()` and its normalized union leave the remote/runtime path.
If no other internal consumer needs them, remove the module and its obsolete
tests rather than keeping a misleading second message model.

`ClaudeSdkInputStream` remains the single task-owned
`AsyncIterable<SDKUserMessage>`. The raw route passes parsed SDK user messages
to a task-manager operation that writes them into this same stream.

The SDK package exports TypeScript types but no supported runtime validator.
The network boundary therefore performs only a non-mutating transport guard:
valid JSON object, `type === "user"`, SDK-required top-level structure, and
JSON-safe values. It must retain unknown and optional SDK fields and submit the
original object. Semantic interpretation belongs to the pinned SDK.

## Task Runtime and Scheduling

Replace the HTTP-only `submitInstruction` conversation path with a raw SDK
message submission operation. Raw SDK frames do not use `operation_results`
and do not carry PocketPilot `operationId`.

- Terminal/closed and explicitly interrupted tasks reject raw input.
- Idle tasks lazily open/resume their one SDK Query.
- An idle message that queries Claude reserves capacity, begins active-turn
  replay retention, and transitions the PocketPilot task into active work.
- A message with `shouldQuery: false` is forwarded without inventing a turn;
  the SDK appends it according to its own contract.
- Executing and approval-waiting tasks accept later messages immediately.
  `priority`, `shouldQuery`, and SDK behavior determine ordering and effect.
- Task lanes may serialize simultaneous socket callbacks only to preserve
  arrival order; they must not reject messages merely because one turn is
  active.
- Raw SDK `result` and `system/session_state_changed` messages may be observed
  for PocketPilot lifecycle bookkeeping after they are published. Observation
  must not alter the object sent remotely.

Each accepted input creates metadata-only audit information. No message field,
prompt, UUID, tool result, or serialized body enters the audit or idempotency
tables.

## Transient Replay

The current active-turn replay budget, encryption, and cleanup rules remain.
Internally, evolve the journal to retain two record categories while sharing
one ordered encrypted store:

```ts
type RetainedTurnRecord =
  | { channel: "sdk"; storageCursor: number; message: SDKMessage }
  | { channel: "control"; storageCursor: number; event: TaskControlEnvelope };
```

This is an internal encrypted transport record and never crosses the raw SDK
WebSocket. The journal exposes separate methods such as:

```ts
publishSdkMessage(taskId, message): void;
publishControlEvent(taskId, event): TaskControlEnvelope;
subscribeSdk(taskId, afterUuid, subscriber): Unsubscribe;
subscribeControl(taskId, afterCursor, subscriber): Unsubscribe;
```

Maintain an in-memory `uuid -> storageCursor` map for the active turn. No UUID
needs to be added to SQLite in plaintext. On SDK subscription:

- known `afterUuid`: emit later retained SDK records in order;
- missing `afterUuid`: emit the retained current turn from the beginning;
- unknown/expired `afterUuid`: fall back to the current-turn beginning;
- messages without UUID remain valid and are replayed normally;
- every emitted replay/live frame is the retained raw SDK object only.

The existing encrypted `event_overflow` rows are transient and deleted on
startup, idle, or terminal cleanup. The internal record shape can change
without a database migration because no old row survives secure startup. The
256 MiB cap stops later retention but not live raw SDK delivery; the control
stream announces the cap.

## Authentication and Connection Ownership

Both WebSockets authenticate with the existing device access credential. Both
register with `InMemoryDeviceConnectionRegistry`, so device revocation and
verified refresh-token reuse close SDK and control sockets with code `4003`.

SDK sockets are task-specific but paired devices retain the current equal-owner
task-control model. The route does not expose local administration, storage
paths, credentials, or Claude configuration.

## API Documentation

Update the OpenAPI 3.1 `x-websocket` documentation to describe two distinct
protocols:

- `/v1/tasks/{taskId}/sdk`: raw bidirectional SDK types, pinned npm package
  version, `SDKUserMessage` client frames, `SDKMessage` server frames,
  `afterUuid`, authentication, close codes, and replay fallback.
- `/v1/events`: PocketPilot control envelopes only, including full serializable
  SDK approval callback data but no SDK conversation messages.

Do not hand-copy the full evolving SDK unions into a Zod-owned parallel model.
The document identifies `@anthropic-ai/claude-agent-sdk@0.3.210` as the message
source of truth and clearly marks the raw message schema as SDK-owned. Generated
examples may be type-checked against SDK types but must contain no real prompt,
output, tool input, credential, or machine path.

Remove `/v1/tasks/{taskId}/instruction` from the current pre-release `/v1`
contract. Update path-set and isolation tests without preserving an obsolete
compatibility handler.

## Security and Error Boundaries

- Parse client JSON before task submission; never log the raw frame or rejected
  value.
- Preserve unknown SDK fields but reject non-object, non-user, malformed base
  frames before they reach the input stream.
- Convert internal SDK/session failures into socket closure and control state;
  never serialize raw internal exception text.
- Continue encrypting transient overflow with record-specific AES-GCM context.
- Continue deleting active-turn replay on idle/terminal/startup.
- Never persist conversation frames in tasks, operation results, audit records,
  settings, or permanent transcript tables.

## Compatibility, Rollout, and Rollback

This intentionally breaks the unpublished normalized `/v1` SDK event contract.
Mobile prototypes must switch to the raw task SDK socket and control stream
separation. No `/v2` or compatibility window is required.

Rollback is code-only because no durable schema migration is required. Revert
the raw route/session/journal changes together; do not leave both transformed
and raw SDK streams active, which would create ambiguous duplicate delivery.

## Likely Files

- `src/claude-sdk/session.ts`, `input.ts`, `event-normalizer.ts`,
  `permission-gate.ts`
- `src/tasks/task-manager.ts`, `task-events.ts`, `task-event-journal.ts`
- `src/remote-api/task-event-routes.ts`, `task-routes.ts`, a task SDK route
  module, and `app.ts`
- `src/api-docs/mobile-openapi.ts`
- `src/runtime/agent-runtime.ts`
- Matching unit/integration/OpenAPI/release tests
- Backend Claude SDK, task runtime, API documentation, device-auth, error, and
  quality specs
