# Agent Provider Parity Design

## Design Goals

This design closes the approved P0/P1 gaps without introducing a universal
agent message model. PocketPilot owns authentication, workspace authorization,
task lifecycle, priority, capacity, event projection, and reconnect policy.
Claude and Codex adapters continue to own their native request, response,
notification, approval, catalog, and history shapes.

The implementation must preserve the existing Claude behavior. Codex work is
integrated through narrow provider-runtime ports rather than by making the
Codex adapter reach into a second repository or scheduler.

## Boundaries

```text
Mobile
  |-- /v1/events -------------------- common task/approval projection
  `-- /v1/tasks/:taskId/agent ------- provider-native frames
                                        |
                             AgentRuntimeManager
                                        |
             +--------------------------+--------------------------+
             |                                                     |
      ClaudeProviderAdapter                               CodexProviderAdapter
             |                                                     |
       TaskManager + SDK Query                         TaskRuntimePort + Bridge
                                                                 |
                                                        Codex App Server stdio
```

`AgentRuntimeManager` remains an identity and authorization router. It does not
interpret provider frames. `TaskManager` remains the single owner of task
priority, capacity, generation invalidation, lifecycle state, and the shared
`TaskEventSink`.

## Shared Task Runtime Port

Add a narrow provider-facing port implemented by `TaskManager` and injected
into `CodexProviderAdapter`. The exact TypeScript names may follow existing
local conventions, but the port must provide these behaviors:

- Run a provider operation in the task lane with a lease that fails after a
  newer P0/P1 generation invalidates it.
- Run an idle-turn capacity reservation under the same capacity lane used by
  Claude. Reservation transitions the task to `executing` before forwarding,
  matching Claude's `startSdkTurn` behavior. If native forwarding fails, roll
  back to `idle` and end the active-turn journal.
- Invalidate queued P2 work for a native P1 interrupt and coordinate the
  existing P0 close/shutdown paths. The port must not expose the scheduler
  implementation or let the adapter mutate task rows directly.
- Publish provider task-state changes through the existing `publishTaskState`
  path and call `beginTurn`/`endTurn` on the event journal at the same lifecycle
  boundaries as Claude.
- Project Codex approval requests into `/v1/events` using the resolved contract:
  `approval.requested` with `{ provider: "codex", requestId, method, params }`.
  The payload is an event projection, not a replacement for the native frame.
- Mark a task as awaiting approval while at least one native server request is
  pending, return to `executing` only when the pending set is empty, and ignore
  late notifications for interrupted or terminal tasks.

The port should be expressed as a `Pick`-style interface at the adapter
boundary. It must be possible to unit-test the adapter with a fake port and to
run all existing Claude tests without constructing a Codex bridge.

## Codex Submission Flow

1. The Agent WebSocket subscribes to the Codex journal before activation, as it
   does today. Authentication, task/provider lookup, frame parsing, and path
   authorization remain in the common route and adapter boundary.
2. The adapter classifies a parsed native frame:
   - `turn/start`: P2; reserve capacity if the task is idle, then forward the
     unchanged native request through the task-runtime port.
   - `turn/steer`: P2; serialize behind the task lane and require the current
     native `expectedTurnId`.
   - `turn/interrupt`: P1; invalidate queued P2 work before forwarding, and
     preserve the native response ID and result. The REST interrupt path
     remains the authoritative P1 lifecycle operation for clients that need
     operation IDs.
   - Native server-request responses: P2; serialize them through the same lane,
     validate the pending request's task/thread/turn/generation ownership, and
     forward the untouched result.
   - Catalog and history reads: read-only operations; validate task/thread and
     workspace but do not consume turn capacity. They must fail on terminal or
     unavailable runtimes.
3. Every operation checks its lease immediately before the bridge write and
   after an awaited bridge call. A superseded operation returns
   `TASK_OPERATION_SUPERSEDED` (or the existing stable WebSocket failure mapping)
   and writes no stale state.
4. JSON-RPC ID remapping remains private to `CodexAppServerBridge`. The client
   sees its original ID in the native response and no PocketPilot envelope.

## Native Turn And Approval State

`onBridgeDelivery` remains the only entry point for unsolicited Codex frames.
It will:

- Reject unauthorized or unowned server requests before journal publication.
- Register each accepted request with bridge generation, task, thread, turn,
  item (when present), and method metadata.
- Publish the original server request to the native journal and publish the
  provider-tagged `approval.requested` control event.
- On `turn/started`, persist the native turn ID and confirm `executing`. A
  pre-forward reservation may already have published `executing`; it must not
  create a duplicate state event.
- On `serverRequest/resolved` or a client response, remove the matching pending
  request and update `awaiting_approval`/`executing` through the task-runtime
  port.
- On `turn/completed`, clear pending requests, clear `activeTurnId`, publish
  `idle`, and end the active-turn journal. A late notification cannot resurrect
  a terminal task.

The native approval request and the control event deliberately travel on
different channels. A mobile client can render from `/v1/events` while using
the native frame's request ID and method-specific response schema on the Agent
WebSocket.

## Reconnect And Replay

Codex will use an active-turn replay contract instead of adding a cursor field
to native frames:

- `CodexNativeJournal` gains `beginTurn`/`endTurn` semantics. Starting a turn
  resets the retained frame window; completing, interrupting, closing, or
  revoking a task clears it.
- A Codex Agent WebSocket reconnect without a cursor replays the complete
  retained active-turn window before subscribing to live delivery. An invalid
  or evicted `afterCursor` also falls back to this same window.
- The mobile reducer discards its in-progress Codex projection on reconnect,
  applies the replay from the beginning, and then resumes live frames. It must
  deduplicate only idempotent terminal/state notifications; text and reasoning
  deltas are never appended to the pre-disconnect projection a second time.
- If the turn completed before reconnect, the client reads native history and
  reconciles the final item list. History remains the provider-native source of
  truth.

This provides deterministic no-loss/no-duplicate behavior without exposing a
PocketPilot cursor in a Codex frame or inventing a cross-channel checkpoint
protocol. The existing cursor parameter remains accepted for compatibility, but
its Codex meaning is only “replay after a retained internal position”; clients
must not derive it from `threadId`, `turnId`, or `itemId`.

## Configuration And Command Surface

- `model/list`, `collaborationMode/list`, and `permissionProfile/list` remain
  native catalog reads. The client renders the installed Codex values and
  sends selected values only in native `turn/start`/`turn/steer` parameters.
- Common Claude REST controls must not report a successful Codex metadata-only
  update. They either reject Codex with an explicit unsupported-provider error
  or are removed from the Codex client path. No Claude enum is reused for
  Codex effort, mode, permission, or sandbox fields.
- Codex exposes no fixed PocketPilot slash-command panel unless the installed
  App Server advertises an official command catalog. Claude command rows and
  same-task `/clear` semantics are not copied to Codex. Existing native input
  remains available where Codex supports it.
- Existing conversation REST operations continue to create or attach the
  native Codex thread. New-thread creation is the Codex equivalent of a new
  conversation; it does not rotate `taskId` inside an existing thread and does
  not emulate Claude `conversation_reset`.

## Failure And Security Boundaries

- Path authorization remains before every Codex bridge write. Prompt text stays
  opaque; only known path-bearing fields are checked.
- A stale approval, stale turn, old bridge generation, unauthorized path,
  terminal task, or superseded operation produces the existing stable error
  code and never reaches the new App Server generation.
- P0 close, shutdown, and workspace revocation clear native pending requests,
  invalidate all task-lane generations, end journal retention, and close only
  the selected task's Agent socket.
- No Codex native frame is written to task operation results, audit payloads,
  or logs. Logs contain metadata such as task, provider, method, and result,
  never prompts, approval input, or model output.

## Compatibility And Rollback

- No database migration is expected: existing `provider`, native IDs,
  `activeTurnId`, and task state fields are sufficient.
- Existing persisted Codex tasks continue through the adapter. If the shared
  runtime port is unavailable, the adapter fails closed rather than forwarding
  directly as it does today.
- The change can be rolled back by disabling the parity gateway registration;
  Claude routes and persisted Claude tasks are unaffected. The native Codex
  thread data remains owned by Codex and is not modified by rollback.

## Explicitly Deferred

Codex thread rename/archive/delete/fork/compact, mobile file/image upload, and
broader live approval/attachment coverage remain P2 follow-up work. This task
must not add privileged raw methods or a mobile upload API to satisfy them.
