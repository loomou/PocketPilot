# Research - Mobile integration guide

## Sources of Truth

The guide must be derived from current executable and generated contracts, in
this order:

1. `dist/openapi/mobile-v1.json` and `src/api-docs/mobile-openapi.ts` for the
   published REST path set, authentication metadata, response schemas, and
   `x-websocket` descriptions.
2. Runtime Zod schemas and handlers under `src/auth/`, `src/remote-api/`, and
   `src/tasks/` for exact admission, error, close, state, and replay behavior.
3. `@anthropic-ai/claude-agent-sdk@0.3.210` declarations for raw
   `SDKUserMessage`, `SDKMessage`, `SessionMessage`, `PermissionResult`, and
   `conversation_reset` ownership.
4. Tests under `test/auth/`, `test/remote-api/`, `test/tasks/`, and
   `test/claude-sdk/` for representative valid/invalid payloads and observable
   races.
5. `.trellis/spec/backend/` contracts and archived task research for rationale
   that is not represented by OpenAPI alone.

`README.md` already links local Swagger UI at `/documentation/`, raw OpenAPI at
`/documentation/json`, and the packaged `dist/openapi/mobile-v1.json`. It does
not provide an end-to-end mobile state/data flow, so the new guide complements
rather than replaces generated API documentation.

## Published Endpoint Inventory

The generated document currently exposes these mobile operations:

| Area | Operations |
| --- | --- |
| Pairing | `registerPairingDevice`, `createPairingClaimChallenge`, `claimPairingCredentials` |
| Authentication | `createRefreshChallenge`, `refreshCredentials`, `getAuthenticatedDeviceSession` |
| Capability/workspace | `getCapabilities`, `listAuthorizedWorkspaces` |
| Sessions | `listClaudeSessions`, `createClaudeConversation`, `readClaudeSessionHistory`, `attachClaudeSession` |
| Tasks | `listTasks`, `createTask`, `getTask`, `interruptTask`, `closeTask`, `resumeTask` |
| Composer | `getTaskComposerOptions`, `setTaskModel`, `setTaskPermissionMode`, `setTaskEffort` |
| Approval | `resolveTaskApproval` |
| WebSocket | `subscribeTaskEvents`, `streamTaskSdkMessages` |

Only pairing registration/claim and credential refresh bootstrap operations are
public. The authenticated session, workspaces, sessions, tasks, controls,
approvals, and both WebSocket handshakes require Bearer access credentials.
Local `/admin/*`, `/_internal/*`, documentation routes, and `/healthz` are not
part of the mobile `/v1` contract.

## Identity and Ownership Findings

- `taskId` is a PocketPilot runtime/control-channel UUID. It owns routing,
  state, scheduling, approval, audit correlation, replay, and the long-lived
  Query. It is not a transcript ID and is intentionally hidden as a user-facing
  conversation concept.
- `sdkSessionId` is the Claude persistence/resume reference. It is observed from
  raw SDK messages and passed through `Options.resume`.
- SDK `uuid` values identify SDK/history messages and are used for SDK replay
  anchors plus client-side history/live deduplication. A valid raw message may
  omit `uuid`.
- `new_conversation_id` appears on raw `conversation_reset`. It tells a surface
  to mount a fresh transcript and clear cached title state. PocketPilot does not
  rotate `taskId` or wrap the event.
- `operationId` is a client-generated HTTP mutation idempotency key and never
  belongs in raw SDK frames.
- Approval `requestId` identifies the pending SDK permission callback. Control
  event cursor and SDK `afterUuid` are separate replay mechanisms.

## Session, History, and Live Findings

- `GET /v1/workspaces` returns configured authorized roots only. Each session
  operation re-canonicalizes and re-authorizes the selected workspace.
- Session listing explicitly excludes worktrees and includes programmatic
  sessions. Session rows and history messages preserve SDK-owned extensions.
- History first validates the selected session, returns chronological pages of
  at most 50, uses the earliest loaded SDK UUID as `beforeUuid`, and returns
  `HISTORY_CURSOR_STALE` when the cursor no longer belongs to the current
  filtered chain.
- The local SDK may parse the full transcript for each history request;
  pagination bounds network/render work, not local parsing. The Agent retains no
  transcript cache.
- A raw SDK subscriber is installed before activating a new/resumed
  session-centric Query. History failure is independent from Query attachment
  and composer readiness.
- Historical `SessionMessage` and live `SDKMessage` remain different SDK types.
  The mobile client prepends/append them and deduplicates by SDK UUID where
  available; the Agent does not project them into a shared transcript model.

## WebSocket Findings

### Raw SDK socket

`GET /v1/tasks/{taskId}/sdk?afterUuid=...` is authenticated and bidirectional.
Client frames are raw `SDKUserMessage`; server frames are raw `SDKMessage`.
There is no PocketPilot envelope or JSON error frame.

Stable close codes:

| Code | Reason |
| --- | --- |
| `4000` | `SDK_MESSAGE_INVALID` |
| `4003` | `AUTHENTICATION_FAILED` |
| `4004` | `TASK_NOT_FOUND` |
| `4009` | `TASK_SESSION_UNAVAILABLE` |
| `4011` | `SDK_TRANSPORT_FAILED` |

A known `afterUuid` replays later retained SDK records; absent or unknown
anchors replay the retained current turn from its beginning. Replay retention
ends with the active turn.

### Control socket

`GET /v1/events` is authenticated and transports only PocketPilot messages:

- client: `{ type: "subscribe", taskId, afterCursor }`
- server: `subscribed`, `event`, or `EVENT_SUBSCRIPTION_INVALID` error

Control envelopes contain task ID, cursor, occurrence time, and control event.
They carry task state, approval, and replay-limit notifications, never SDK
conversation data. Device revocation closes both device sockets; P0 task close
or root removal closes only the affected raw task socket while the device's
control socket remains available.

## Task, Control, and Approval Findings

- Persisted states are `idle`, `executing`, `awaiting_approval`, `interrupted`,
  and `terminal`.
- Runtime priority is P0 shutdown/close/root revocation, P1 interrupt, P2 raw
  input/approval/control/activation/resume, and P3 catalog/history/status reads.
  SDK `priority` and `shouldQuery` pass unchanged and are not mapped to P0-P3.
- Raw messages are accepted while executing or awaiting approval. SDK queuing
  owns their effect; PocketPilot serializes handoff only for deterministic
  arrival/control order.
- Model, permission, and effort change the existing Query and affect the next
  turn. A client awaits the control response before Send when order matters.
- Approval control delivers all serializable `CanUseTool` options except the
  local `AbortSignal`; the HTTP resolution request submits the complete SDK
  `PermissionResult`, while the response remains the shared task-operation
  metadata shape. Interrupt, close, replacement, abort, and shutdown can
  invalidate an approval.
- Disconnect never interrupts work. Interrupt returns the same Query/session to
  idle after cancellation; close makes the task terminal and non-resumable.

## Command and Reset Findings

The approved fixed mobile panel contains:

- `/compact <optional custom summarization instructions>`
- `/context`
- `/usage` (aliases `/cost`, `/stats`)
- `/rename [name]` (alias `/name`)
- `/recap`
- `/review [pr number]`
- `/security-review`
- `/code-review [low|medium|high|xhigh|max] [<target>]`

The panel omits `ultra`, `--fix`, and `--comment` for `/code-review`, but raw
manually typed input is not filtered. A selected command is only a string in
the ordinary raw SDK user message; no slash-specific backend API exists.

`/clear`, `/reset`, and `/new` belong to same-workspace New conversation, not
the panel. `/clear` is not an implicit interrupt. If work or approval is active,
the surface first uses explicit interrupt/cancellation and waits for a stable
state before sending `/clear`. Raw `conversation_reset` switches the UI to
`new_conversation_id` while retaining the PocketPilot task runtime and socket.

## Documentation Strategy

- Canonical source: `docs/mobile-integration-guide.en.md`.
- Strict translation: `docs/mobile-integration-guide.zh-CN.md`.
- Both files use identical section order and equivalent tables, diagrams, JSON,
  warnings, and checklists. Technical identifiers and code blocks stay English
  in both.
- Content remains platform-neutral: HTTP, WebSocket, JSON, pseudocode, and
  Mermaid sequence/state diagrams only.
- Examples use synthetic UUIDs, paths, messages, tokens, keys, and timestamps.
- README links both guides. Generated OpenAPI remains the detailed REST schema
  rather than being copied into prose.

## Validation Approach

- Regenerate/build OpenAPI and compare every mentioned mobile path to the
  current path set.
- Check all error/close/state identifiers against source constants and route
  tests.
- Compare English/Chinese heading levels, code-fence count/content, tables,
  endpoint path sets, error-code sets, and command sets.
- Check Markdown relative links and README links.
- Scan examples for real workspace paths, secrets, prompts, keys, or tokens.
- Run repository lint, typecheck, tests, and production build because README and
  packaged-document references are release assets.
