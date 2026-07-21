# Implement Codex native action capabilities

## Goal

Expose trustworthy Codex-native review, rename, and compact capabilities to
remote clients while preserving App Server JSON-RPC frames and PocketPilot's
shared task lifecycle. Stop advertising mobile attachments until an actual
authenticated mobile attachment flow exists.

## Background

PocketPilot already transports native Codex App Server frames through
`/v1/tasks/{taskId}/agent`, but the remote allowlist in
`src/codex-app-server/protocol.ts:9-24` does not accept `review/start`,
`thread/name/set`, or `thread/compact/start`. The Codex descriptor currently
advertises `attachments: true` at
`src/codex-app-server/provider-adapter.ts:113-128` even though PocketPilot has no
authenticated mobile upload or reference API.

The installed Codex CLI 0.144.6 schema confirms that:

- `review/start` requires the task thread and a native review target, supports
  `inline` or `detached` delivery, and returns a native turn plus the thread in
  which that turn runs.
- `thread/compact/start` starts a native compact turn. Codex identifies review
  and manual compact as non-steerable turn kinds.
- `thread/name/set` changes the current native thread name without starting a
  turn.
- `thread/compacted` and `thread/name/updated` are already forwarded by
  `src/codex-app-server/protocol.ts:52-55`.

## Requirements

### R1 - Trustworthy capability discovery

- Set the available Codex provider's `attachments` capability to `false`.
- Extend the common provider capability snapshot with a diagnostics-safe
  `nativeActions` object. It must advertise only actions that the provider can
  execute through the current remote transport.
- The Codex descriptor must publish:
  - `review`: native method `review/start`, available only while the task is
    idle, starts a turn, supports only `inline` delivery, and accepts native
    targets `uncommittedChanges`, `baseBranch`, `commit`, and `custom`.
  - `rename`: native method `thread/name/set`, available while idle or active,
    and does not start a turn.
  - `compact`: native method `thread/compact/start`, available only while the
    task is idle, and starts a turn.
- Capability sanitization and OpenAPI schemas must project only the reviewed
  fields. Other adapter properties remain private.

### R2 - Native transport and validation

- Add `review/start`, `thread/name/set`, and `thread/compact/start` to the Codex
  client request allowlist.
- Continue accepting and emitting native Codex JSON-RPC objects. Do not add a
  PocketPilot action envelope, Claude slash-command mapping, translated target,
  or synthetic response.
- Bind every action to the task's persisted Codex thread. A caller-supplied
  different `threadId` must continue to fail before native forwarding.
- Reject `review/start` unless `delivery` is omitted, `null`, or `inline` and
  its target matches one of the four supported native target variants. Reject
  `detached` before forwarding because its new thread is not bound to a
  separate PocketPilot task.
- Validate rename input as a non-empty bounded name and compact input as the
  current thread only. Invalid or unsupported action parameters must fail with
  a stable PocketPilot error and must not reach App Server.

### R3 - Turn lifecycle and operation priority

- Treat inline review and compact as P2 turn-starting operations, equivalent to
  `turn/start` for PocketPilot lifecycle accounting:
  - require an idle task with no active turn;
  - reserve shared Claude/Codex active-task capacity before forwarding;
  - begin the retained native turn journal;
  - record the initiating device and pending turn kind;
  - roll back task state, capacity, pending ownership, and journal retention if
    forwarding fails or App Server returns an error before `turn/started`.
- Use native `turn/started` as the authoritative active turn ID and native
  `turn/completed` as the authoritative completion signal for review and
  compact. The original native request response remains a correlation response,
  not a replacement lifecycle signal.
- Reject `turn/steer` while the active native turn kind is review or compact.
  Native interrupt remains supported for the current turn.
- Run rename through the existing P2 task lane so P0 close/root revocation and
  P1 interrupt can invalidate older queued work. Rename does not reserve
  capacity and may be forwarded while a normal, review, or compact turn is
  active.
- Recheck task generation, task/thread identity, and current workspace
  authorization at the same checkpoints used by existing P2 Codex mutations.

### R4 - Documentation and compatibility

- Update the English and Simplified Chinese Codex mobile integration guides
  with the capability shape, exact native request examples, state gating,
  inline-only review rule, non-steerable review/compact behavior, native
  notifications, and attachment unavailability.
- Update the Codex App Server integration guide where its allowlist or
  capability examples would otherwise be stale.
- Keep the feature within the reviewed Codex App Server 0.144.x protocol
  boundary. Unknown future native methods remain denied until reviewed.

## Acceptance Criteria

- [ ] `/v1/providers` and `/v1/providers/codex/capabilities` report Codex
      `attachments: false` and the exact reviewed `nativeActions` descriptors;
      generated OpenAPI describes the same response shape.
- [ ] Claude and fake-provider capability responses remain valid and explicitly
      advertise an empty or provider-appropriate `nativeActions` object.
- [ ] The Agent WebSocket accepts native `review/start`, `thread/name/set`, and
      `thread/compact/start` frames and preserves native request IDs, params,
      responses, and notifications apart from the bridge's private wire-ID
      correlation and enforced current `threadId`.
- [ ] Detached review, unsupported review targets, invalid rename names,
      mismatched thread IDs, and malformed action frames are rejected without
      forwarding.
- [ ] Inline review and compact require idle, share cross-provider capacity,
      enter the active-turn journal, roll back on forward/native response
      failure, and settle only from native turn lifecycle notifications.
- [ ] Review and compact turns reject steering but allow interrupt of the
      current native turn.
- [ ] Rename uses P2 ordering, is invalidated by P0/P1 when stale, consumes no
      active capacity, and works while a turn is active.
- [ ] Workspace revocation and terminal task state prevent all three actions
      from being forwarded or from writing later task state.
- [ ] Focused protocol, adapter, provider capability, remote route/OpenAPI, and
      bilingual documentation checks pass.

## Out of Scope

- Mobile file upload, computer-side attachment selection, or any attachment
  reference protocol.
- Detached review or binding its new Codex thread to a new PocketPilot task.
- Claude slash-command translation, a shared Claude/Codex message schema, or
  PocketPilot-generated review prompts.
- Other Codex native actions, thread archive/delete/fork/rollback, account and
  quota state, skills/hooks/MCP discovery, provider readiness probes, or replay
  checkpoint optimization.
- Mobile application implementation.

