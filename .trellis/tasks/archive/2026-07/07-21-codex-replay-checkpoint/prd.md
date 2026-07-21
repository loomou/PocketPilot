# Codex replay checkpoint

## Goal

Expose an out-of-band reconnect checkpoint for Codex Agent streams so clients can reconnect with a known `afterCursor` and receive only later retained frames, without embedding PocketPilot metadata in native Codex frames.

## Background

- Codex Agent WS: `GET /v1/tasks/{taskId}/agent?afterCursor={opaque}` (`src/remote-api/task-agent-routes.ts`).
- Today the socket is documented as pure provider-native JSON with no PocketPilot wrapper.
- `CodexNativeJournal` already assigns monotonic numeric cursors, supports known-cursor incremental replay, exposes `latestCursor(taskId)`, and keeps cursor out of frames (`src/codex-app-server/journal.ts`, unit tests).
- Subscribe currently: `CodexProviderAdapter.taskStream.subscribe` → `journal.subscribe(taskId, afterCursor, subscriber)` with no checkpoint emission.
- Docs instruct omitting `afterCursor` and full active-turn rebuild (`docs/codex-mobile-integration-guide.en.md` §10.2).
- Residual P3 from archived parent audit `07-20-claude-code-parity-audit`.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Delivery channel | Agent WS out-of-band control frame on the same socket |
| 2 | Cadence | Subscribe-time only (not per-publish, not periodic) |
| 3 | Ordering / scope | Emit **once before retained replay**, **Codex-only**; Claude Agent socket unchanged |
| 4 | Payload | `{ kind: "agent.checkpoint", payload: { provider: "codex", cursor: string \| null } }` |

## Requirements

1. **Subscribe-time checkpoint (Codex)**
   - On each successful Codex Agent `taskStream.subscribe`, before replaying retained frames to that subscriber, send exactly one out-of-band frame:
     ```json
     {
       "kind": "agent.checkpoint",
       "payload": {
         "provider": "codex",
         "cursor": "180"
       }
     }
     ```
   - `cursor` is `journal.latestCursor(taskId)` at emit time, or `null` when no retained window exists.
   - Frame must not look like Codex JSON-RPC (`jsonrpc`/`method`/`id` native shapes).
2. **Native frames remain pure**
   - Retained and live Codex frames stay unmodified; never inject cursor into them.
3. **Reconnect client contract**
   - Clients may store a non-null checkpoint `cursor` and pass it as `afterCursor` on the next Agent open.
   - Known cursor → only later retained frames; unknown/stale/missing → full retained active-turn window (existing journal behavior).
   - Subscribe-time-only means the checkpoint may lag live frames published after subscribe; next reconnect may re-deliver a short tail. Full-window fallback remains correct.
4. **Claude unchanged**
   - Claude Agent socket does not emit `agent.checkpoint` in this task.
5. **Docs / OpenAPI / contracts**
   - Update Codex mobile + app-server guides: optional first out-of-band checkpoint frame; subsequent frames native; optional `afterCursor` usage.
   - Update agent-provider / codex-app-server / api-documentation contracts for the control frame and ordering.
   - Adjust route docs that currently claim the Agent stream has no PocketPilot wrapper (Codex exception for this single control frame).

## Acceptance Criteria

- [ ] Codex Agent subscribe sends exactly one `agent.checkpoint` before any retained native frames for that subscription.
- [ ] Checkpoint `cursor` matches `latestCursor` (string or null); never embeds into native frames.
- [ ] Reconnect with that cursor yields only later retained frames when still known; stale/unknown still full-window.
- [ ] Claude Agent subscribe does not emit `agent.checkpoint`.
- [ ] Docs and contracts describe the Codex out-of-band checkpoint and updated reconnect guidance.
- [ ] Unit/route tests cover emit ordering, null cursor, and non-injection into native frames.

## Out of Scope

- Per-publish or periodic checkpoint streaming (follow-up).
- Embedding cursors in Codex native JSON-RPC frames.
- Claude Agent checkpoint emission.
- Cross-process / multi-node journal persistence.
- Attachments and history-filter work (done elsewhere).
