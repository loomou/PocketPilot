# Design: Codex replay checkpoint

## Boundaries

- **Codex journal / adapter only** for emission (Codex-only scope).
- **Agent WS transport** (`task-agent-routes`) remains provider-agnostic: it already `JSON.stringify`s whatever `subscriber.send` receives.
- **Claude** paths and SDK journal unchanged.
- **Control-events WS** (`/events`) not used as primary checkpoint channel.

## Architecture

```text
Client opens GET /v1/tasks/{taskId}/agent[?afterCursor=N]
  -> task-agent-routes upgrade
  -> provider.taskStream.subscribe(taskId, afterCursor, { send })
  -> CodexProviderAdapter / CodexNativeJournal:
       1. send agent.checkpoint { provider:"codex", cursor: latestCursor|null }
       2. replay retained frames after afterCursor (existing logic)
       3. register live subscriber
```

Preferred implementation point: **inside `CodexNativeJournal.subscribe`** (or a thin wrapper in adapter.subscribe) so every Codex subscriber gets the same ordering without route branching.

```ts
// Conceptual
subscribe(taskId, afterCursor, subscriber) {
  subscriber.send({
    kind: "agent.checkpoint",
    payload: {
      provider: "codex",
      cursor: this.latestCursor(taskId), // string | null
    },
  });
  // existing: snapshot retained after afterCursor, send each frame, then register
}
```

## Frame discrimination

Clients must distinguish:

| Frame | Discriminator |
|-------|----------------|
| Checkpoint | `kind === "agent.checkpoint"` and no `jsonrpc` |
| Native Codex | JSON-RPC shapes (`jsonrpc`, `method`, `result`, `error`, `id`) |

Do not reuse `TaskControlEvent` wire format on the Agent socket beyond this single reviewed kind. Keep payload closed: only `provider` + `cursor`.

## Ordering

1. Checkpoint first (reflects window **before** this subscriber receives replay; for a known afterCursor, cursor is still the window end, not "what will be sent next").
2. Then retained frames for this subscription.
3. Then live frames.

Note: checkpoint cursor is the **current latest retained cursor**, not the first frame about to be sent. Clients use it as the next reconnect `afterCursor` after applying whatever they receive on this connection (or they may update local last-seen only from retained/live native frames if they choose a more advanced strategy later). For this MVP, documented client rule:

- On subscribe, record `checkpoint.payload.cursor` if non-null as a safe reconnect base **after** processing this connection's replay/live (or immediately if client rebuilds from full window).
- Simpler documented rule: after finishing retained replay + any live processed while connected, the client may treat the last known journal position as the checkpoint from subscribe only if no further frames arrived; otherwise clients that only do subscribe-time still benefit on short connections and as a first known cursor.

**Clarify for implementers/docs (authoritative MVP client rule):**

1. On open, read first frame; if `agent.checkpoint`, store `payload.cursor` as `lastCheckpoint`.
2. Apply retained + live **native** frames to UI.
3. On disconnect, reopen with `afterCursor=lastCheckpoint` when non-null **only if** the client discarded pre-disconnect projection and is willing to accept possible short re-replay of frames published after that checkpoint was taken.
4. Safer advanced clients (future): track last applied native frame's implied position via follow-up per-publish checkpoints (out of scope).

For correctness of server: known-cursor math already handles unknown/stale.

## Compatibility

- Old clients that assume every frame is native: must ignore/skip frames with `kind` and no `jsonrpc`. Document this clearly; this is a deliberate protocol extension.
- Omitting `afterCursor` still full-window (unchanged).
- Claude streams unchanged.

## Risks

- Clients that naively parse every message as JSON-RPC may error on checkpoint → docs + tests + openapi description must call out skip rule.
- Subscribe-time-only lag under long turns → accepted P3 MVP trade-off.

## Rollback

- Stop emitting checkpoint; docs revert to omit-afterCursor guidance. Journal math unchanged.

## Non-goals

- Per-frame checkpoint
- Dual-socket dependency
- Persisted cursors across process restart
