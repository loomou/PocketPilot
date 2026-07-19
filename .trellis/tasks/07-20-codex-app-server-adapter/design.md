# Codex App Server adapter design

## Blocking dependency

Implementation starts only after `07-20-agent-api-claude-migration` establishes
the common adapter, persistence, conversation-route, and native-stream contracts.
This task consumes those contracts and must not alter them to normalize Codex
payloads into Claude or a universal event model.

## Architecture

```text
AgentRuntimeManager
  `-- CodexProviderAdapter
        |-- CodexAppServerBridge -> codex app-server stdio JSONL
        |-- CodexThreadCatalog
        |-- CodexTurnController
        |-- CodexApprovalRegistry
        `-- CodexNativeJournal
```

The bridge owns process lifecycle, handshake, JSON-RPC correlation, frame
validation, and stderr diagnostics. Catalog, turn, approval, and journal modules
own provider behavior. Common authentication, workspace policy, task scheduling,
idempotency, capacity, and audit remain outside the adapter.

## Identity and data flow

`taskId`, `threadId`, `sessionId`, `turnId`, `itemId`, JSON-RPC request ID, and
PocketPilot replay sequence remain distinct. Task metadata exposes provider and
protocol version before stream connection. Native JSON-RPC frames flow unchanged
through `/v1/tasks/{taskId}/agent`; replay sequence remains transport metadata.

## History and active input

`thread/list` explicitly requests `cli`, `vscode`, and `appServer` sources, then
filters canonical cwd values using descendant workspace authorization. Stable
`thread/read(includeTurns=true)` is the baseline. Experimental turn/item
pagination is used only when negotiated, with an explicit bounded fallback.

Idle input uses `turn/start`. Input during an active turn uses
`turn/steer(expectedTurnId)`. Interrupt waits for native completion instead of
fabricating a terminal state.

## Approvals and security

The approval registry keys concurrent server requests by JSON-RPC request ID and
binds device, task, thread, turn, item, and method. It clears requests on native
resolution, turn completion, interrupt, close, revocation, bridge exit, and
shutdown. Only allowlisted methods and authorized paths cross the remote
boundary; unknown privileged methods fail closed.

## Failure and rollback

Bridge exit rejects pending requests, terminalizes affected runtime state, and
emits diagnostics-safe remote errors. Provider registration can be disabled
locally to stop new Codex tasks. Rollback does not alter Codex-owned thread data,
account state, or local configuration.
