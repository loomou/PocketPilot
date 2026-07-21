# Design: Codex native action capabilities

## Architecture and boundaries

The provider descriptor remains the only common discovery surface. Extend
`AgentCapabilitySnapshot` with a sanitized `nativeActions` object whose keys are
PocketPilot semantic action IDs and whose values describe how that provider
exposes the action natively. The descriptor is metadata only; execution stays
on `/v1/tasks/{taskId}/agent` as native provider frames.

The initial common shape is:

```ts
type AgentNativeActions = {
  review?: {
    availability: "idle";
    deliveries: readonly ["inline"];
    method: string;
    startsTurn: true;
    targetTypes: readonly [
      "uncommittedChanges",
      "baseBranch",
      "commit",
      "custom",
    ];
  };
  rename?: {
    availability: "always";
    method: string;
    startsTurn: false;
  };
  compact?: {
    availability: "idle";
    method: string;
    startsTurn: true;
  };
};
```

The exact TypeScript representation may use readonly arrays and Zod enums, but
the serialized fields and values above are the public contract. Available
providers publish `nativeActions`; providers without these actions publish an
empty object. This makes absence explicit, keeps the sanitizer allowlist
closed, and permits future providers to map the same semantic action to a
different native method without changing the transport.

No new REST mutation route is added. A mobile client discovers the action via
REST, opens the existing Agent WebSocket, then submits the method and params
defined by the provider's native protocol.

## Action contracts

### Inline review

Accepted native request:

```json
{
  "id": 21,
  "method": "review/start",
  "params": {
    "threadId": "thr_123",
    "delivery": "inline",
    "target": { "type": "uncommittedChanges" }
  }
}
```

`delivery` may be omitted or `null`, because App Server defines inline as the
default. PocketPilot rejects `detached`. The target is validated as a strict
discriminated union:

- `{ type: "uncommittedChanges" }`
- `{ type: "baseBranch", branch: <non-empty bounded string> }`
- `{ type: "commit", sha: <non-empty bounded string>, title?: string | null }`
- `{ type: "custom", instructions: <non-empty bounded string> }`

Unknown top-level native extension fields can remain passthrough-compatible,
but the security- and routing-relevant delivery, thread, and target fields must
match the reviewed subset. The request remains native after validation.

### Rename

Accepted native request:

```json
{
  "id": 22,
  "method": "thread/name/set",
  "params": { "threadId": "thr_123", "name": "Provider parity audit" }
}
```

The name is trimmed for validation but is not rewritten before forwarding. Use
a conservative length bound consistent with other remote text fields. Rename
does not create a turn and therefore does not change task state, active turn,
capacity, or journal boundaries. Existing `thread/name/updated` forwarding is
the authoritative UI update.

### Compact

Accepted native request:

```json
{
  "id": 23,
  "method": "thread/compact/start",
  "params": { "threadId": "thr_123" }
}
```

Compact starts a non-steerable native turn even though its immediate response
schema is an empty object. Existing `turn/started`, streamed item events,
`thread/compacted`, and `turn/completed` remain unchanged and authoritative.

## Turn-starting state machine

Generalize the adapter's current `turn/start` path so `turn/start`, inline
`review/start`, and `thread/compact/start` share one helper and pending-start
record. A pending entry records at least the initiating device and native turn
kind (`normal`, `review`, or `compact`).

```text
idle
  -> validate current task/thread/workspace and action params
  -> reserve shared capacity
  -> begin retained journal
  -> store pending start ownership and kind
  -> forward unchanged native request
  -> native turn/started: persist activeTurnId and active kind
  -> native turn/completed: clear active state, release capacity, end journal
```

On a forwarding exception or native error response before `turn/started`,
delete the matching pending entry, clear initiating-device ownership, roll the
task back to idle, release capacity, and end the journal. A successful response
must not discard the pending kind before `turn/started`; compact's response does
not contain a turn. Once `turn/started` has made the turn authoritative, a late
request response must not roll it back.

`activeTurnKind` is adapter runtime state rather than a new persistent task
identity. Existing unexpected-restart activation resumes the thread and resets
unfinished local active work; no non-steerable kind must survive that reset.
While the active kind is review or compact, reject native `turn/steer` locally.
`turn/interrupt` continues to require the current persisted `activeTurnId`.

## Priority and authorization

All three mutations enter `ProviderTaskRuntime.run()` and its P2 generation
lease. Review and compact additionally reserve turn capacity. Rename forwards
after activation, workspace authorization, path validation, and lease
checkpoints but does not inspect idle state.

P0 close/root revocation and P1 interrupt advance the operation generation.
Any older queued action fails at a lease checkpoint with the existing
superseded-operation behavior and performs no later native write or task-state
write. Current-thread injection and mismatch rejection remain centralized in
`prepareTaskRequest()`.

## Protocol and compatibility

Add only the three reviewed methods to `codexClientRequestMethods`. Do not mark
them as P3 reads. Existing bridge correlation privately remaps JSON-RPC IDs and
restores the client's ID on delivery; all other fields remain native.

The capability contract is additive, except that Codex `attachments` changes
from an inaccurate `true` to `false`. Clients must hide attachment UI based on
the current capability response. Clients that ignore unknown `nativeActions`
continue to use existing conversation functionality.

## Failure and rollback considerations

- A validation failure never reaches App Server and never reserves capacity.
- A capacity failure forwards no request and preserves the idle task.
- Forwarding/native start failure uses the existing turn-start rollback path.
- Detached review fails closed; PocketPilot never receives an unbound review
  thread ID that it could accidentally route through the current task.
- Existing unknown-method denial remains the default for future App Server
  versions.
- Reverting the feature consists of removing the three allowlisted methods and
  descriptors. Keeping `attachments: false` remains correct until a separate
  attachment task ships end to end.

## Documentation and specification impact

Update both Codex mobile guides and the English App Server integration guide in
the implementation. During Phase 3, update the provider, Codex App Server, and
task runtime Trellis specs with the final tested action and lifecycle contract.

