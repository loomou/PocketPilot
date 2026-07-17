# Claude SDK Message Passthrough

## Goal

Make the remote client interact with the computer's Claude Code session through
the exact message formats defined by the installed Claude Agent SDK. PocketPilot
is a secured task/session transport and policy boundary; it must not invent a
second conversation-message protocol, normalize SDK message kinds, wrap SDK
messages in PocketPilot event envelopes, or project them into a mobile-specific
message model.

## Confirmed Facts

- The installed `@anthropic-ai/claude-agent-sdk@0.3.210` accepts an
  `AsyncIterable<SDKUserMessage>` as Query input and yields `SDKMessage` values.
- `ClaudeSdkInputStream` already accepts `SDKUserMessage`, but the remote
  instruction API currently accepts only a string and calls
  `createSdkUserMessage()` before SDK submission.
- `ClaudeSdkSession.events()` currently passes every yielded SDK message through
  `normalizeSdkMessage()`. That adapter renames message categories and omits SDK
  `user` messages.
- `TaskManager` wraps each normalized output in
  `{ kind: "sdk", payload: normalizedEvent }`.
- `TaskEventJournal` adds `cursor`, `taskId`, and `occurredAt`; the WebSocket
  route adds another `{ type: "event", event: envelope }` wrapper.
- The generated OpenAPI WebSocket schema describes only the PocketPilot outer
  envelope. Its task-event payload is unconstrained because
  `taskEventEnvelopeSchema` declares `payload: unknown`.
- PocketPilot task metadata, authentication, workspace policy, task lifecycle,
  device revocation, and audit records are separate product responsibilities.
  They are not Claude SDK conversation messages.
- PocketPilot does not persist a canonical Claude transcript. The SDK/Claude
  Code session remains authoritative.

## Requirements

- Remote-to-computer conversation input must use the installed SDK's
  `SDKUserMessage` JSON shape and reach the task's existing
  `ClaudeSdkInputStream` without field renaming, synthetic wrapper objects, or
  conversion from a PocketPilot instruction string.
- Accept the same required and optional fields as the pinned SDK. In particular,
  do not make optional SDK fields such as `uuid` or `session_id` mandatory and
  do not add a PocketPilot `operationId` to SDK WebSocket frames.
- Computer-to-remote conversation output must use the exact `SDKMessage` object
  yielded by the installed SDK Query. PocketPilot must not rename its type,
  remove SDK message variants, project selected fields, or wrap it inside
  `kind`, `payload`, or PocketPilot event objects.
- JSON serialization/deserialization and non-mutating contract validation are
  transport mechanics, not message transformation. A successfully accepted
  message must retain every SDK-defined field and value.
- Authentication and task selection must live outside the SDK JSON message
  body, such as the authenticated WebSocket handshake and task-specific route.
- PocketPilot task/control messages must not be interleaved in a way that can be
  mistaken for `SDKMessage` or `SDKUserMessage` values.
- Use two independent remote channels. A task-specific bidirectional
  `/v1/tasks/{taskId}/sdk` WebSocket carries only raw `SDKUserMessage` input and
  raw `SDKMessage` output. The separate `/v1/events` control stream carries
  PocketPilot task state, approval requests, and reconnect/control notices.
- Task creation, approval decisions, interrupt, close, resume, model changes,
  and permission-mode changes remain authenticated HTTP operations. They do not
  introduce PocketPilot control frames into the SDK WebSocket.
- Treat interactive tool approval as an SDK control contract. The control
  stream sends every serializable `CanUseTool` argument without renaming or
  dropping fields: `toolName`, `input`, and the options fields `suggestions`,
  `blockedPath`, `decisionReason`, `title`, `displayName`, `description`,
  `toolUseID`, `agentID`, and `requestId`. The non-serializable `AbortSignal`
  remains local to the computer-side pending-approval lifecycle.
- The approval response API accepts the installed SDK's complete
  `PermissionResult` shape rather than a PocketPilot-only approve/deny enum.
  Allow results may carry `updatedInput`, `updatedPermissions`, `toolUseID`,
  and `decisionClassification`; deny results may carry `message`, `interrupt`,
  `toolUseID`, and `decisionClassification`.
- The transport must preserve one long-lived SDK input stream and one Claude
  Code session per PocketPilot task. A later SDK user message must continue the
  same session rather than create a new Query.
- Forward every valid SDK user message immediately to the task's long-lived
  input stream while the task session is available, including while Claude Code
  is running or awaiting tool approval. PocketPilot must not return `TASK_BUSY`
  merely because a turn is active.
- Preserve SDK scheduling fields such as `priority` and `shouldQuery` without
  altering them or implementing independent scheduling. PocketPilot may observe
  the SDK-documented `shouldQuery` value only for existing task-capacity and
  lifecycle accounting; Claude Code and the installed SDK own message queuing,
  interruption, and whether/how the message is processed.
- PocketPilot may still enforce task existence, terminal/closed state, device
  authentication, workspace policy at task creation, concurrency when an idle
  task starts querying, and coordinated shutdown. Those lifecycle checks must
  not become a second message scheduler.
- The SDK package remains the source of truth for message shapes. PocketPilot
  must not maintain a hand-copied parallel message union that silently drifts
  when the pinned SDK is upgraded.
- Preserve active-turn reconnect without adding a PocketPilot cursor to raw SDK
  message bodies. The client records the last received SDK message `uuid` and
  reconnects the task SDK WebSocket with `afterUuid` outside the message body.
- PocketPilot may retain raw SDK output transiently for the active turn and map
  SDK UUIDs to internal ordering, but replay must emit the retained SDK objects
  unchanged. If `afterUuid` is absent or cannot be located, replay the current
  turn from its beginning; the client deduplicates messages by SDK UUID when
  available.
- Existing security properties remain: device-bound authentication, immediate
  socket closure after revocation, task ownership/policy checks, no remote local
  administration surface, and no credential or message logging.
- Existing storage boundaries remain: no Agent-managed transcript persistence,
  no plaintext SDK message storage, and no inclusion of SDK message contents in
  audit or idempotency records.
- Raw SDK WebSocket input is not a PocketPilot HTTP state-changing operation and
  is therefore outside the existing 24-hour `(deviceId, operationId)` result
  cache. Each received WebSocket frame is submitted according to SDK semantics.
  HTTP task/control operations retain their existing `operationId` contract.
- Auditing a received SDK input records only safe operation metadata such as
  device ID, task ID, operation name, and result; it never records the message,
  UUID, prompt content, tool result, or other SDK fields.
- API documentation and tests must make the raw SDK passthrough boundary clear,
  including which pinned SDK version defines the wire contract.
- Correct the unpublished pre-release contract directly within `/v1`. Add the
  task-specific SDK WebSocket, remove SDK messages from `/v1/events`, and update
  the approval contract without introducing `/v2` or retaining a normalized
  compatibility stream.

## Acceptance Criteria

- [ ] A representative `SDKUserMessage` sent by the remote client is observed
      by the SDK input stream with deep equality, including optional SDK fields.
- [ ] A valid `SDKUserMessage` with no `uuid`, `session_id`, or PocketPilot
      `operationId` is accepted and reaches the SDK unchanged.
- [ ] Every representative SDK output category is observed remotely with deep
      equality to the object yielded by Query, including `user`, `assistant`,
      `stream_event`, `result`, system, tool-progress, and future/open variants
      permitted by the pinned SDK type.
- [ ] Raw SDK messages contain no PocketPilot `type: "event"`, task-event
      `kind`, `payload`, cursor, task ID, or timestamp wrapper fields.
- [ ] Task selection and Bearer authentication succeed without changing the SDK
      JSON body; revocation still closes only the affected device connections.
- [ ] Multiple later `SDKUserMessage` values use the same task-scoped Query and
      preserve the Claude Code session ID behavior.
- [ ] SDK messages carrying `priority` and `shouldQuery` reach the long-lived
      input stream unchanged while the task is executing or awaiting approval;
      PocketPilot does not return `TASK_BUSY` for those frames.
- [ ] Reconnecting with a retained `afterUuid` replays only later raw SDK
      messages in original order; reconnecting with an unknown UUID replays the
      current turn from its beginning without adding replay metadata to them.
- [ ] PocketPilot control/lifecycle/approval messages cannot be confused with
      raw SDK messages on the wire.
- [ ] The SDK WebSocket rejects non-`SDKUserMessage` client frames and never
      sends a PocketPilot control frame; the control WebSocket never sends an
      SDK conversation message.
- [ ] A representative `CanUseTool` request reaches the remote control stream
      with deep equality for every serializable SDK field, and a representative
      `PermissionResult` reaches the waiting SDK callback with deep equality.
- [ ] SDK abort, task interrupt, close, replacement approval, and shutdown still
      cancel the local pending approval without attempting to serialize an
      `AbortSignal`.
- [ ] No SDK conversation message is added to SQLite, audit records,
      idempotency results, or logs.
- [ ] Generated integration documentation identifies the raw SDK message
      contract and no longer claims that SDK output uses a normalized nested
      PocketPilot payload.
- [ ] Relevant unit, WebSocket integration, OpenAPI, build, package, and Windows
      release tests pass.

## Out of Scope

- Reimplementing the Claude Code terminal UI on the computer.
- Defining a PocketPilot-owned canonical conversation transcript or message
  model.
- Changing the Claude SDK's own message definitions or configuration/credential
  precedence.
- Adding a hosted relay, tunnel management, or remote exposure of localhost
  administration.
