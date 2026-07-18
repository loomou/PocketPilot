# Mobile integration implementation guide

## Goal

Provide authoritative English and Simplified Chinese implementation guides that
the separate PocketPilot mobile team can follow to pair a device, browse
authorized Claude workspaces and sessions, render history and live output,
control a long-lived Claude Query, handle approvals and reconnection, and
implement the fixed Command panel without inventing a second PocketPilot
conversation protocol.

## Background

- The mobile application is developed outside this repository. This task owns
  only its backend integration guide.
- The repository has no `docs/` directory today. `README.md` documents runtime
  operation and points to local Swagger UI plus
  `dist/openapi/mobile-v1.json`, but it does not describe the complete mobile
  screen/state/data flow.
- The generated OpenAPI 3.1 document is the authoritative REST schema. It
  contains pairing/authentication, capabilities, workspaces, sessions, tasks,
  approvals, composer controls, and two `x-websocket` operations.
- `/v1/tasks/{taskId}/sdk` exchanges raw `SDKUserMessage` and `SDKMessage`
  values owned by `@anthropic-ai/claude-agent-sdk@0.3.210`.
- `/v1/events` carries only PocketPilot control events. SDK and PocketPilot
  events must never be merged into one wrapper protocol.
- `taskId` is an internal PocketPilot runtime/control-channel ID;
  `sdkSessionId` identifies a persistent Claude session; SDK message `uuid`
  values support history/live deduplication; `new_conversation_id` identifies
  the transcript boundary after `conversation_reset`; client-generated
  `operationId` values provide HTTP mutation idempotency.
- The mobile MVP uses a fixed eight-command panel. The backend does not expose
  a slash-command catalog or command execution endpoint.

## Requirements

### Document Location and Authority

- Create paired guides at `docs/mobile-integration-guide.en.md` and
  `docs/mobile-integration-guide.zh-CN.md`, and add discoverable labeled links
  to both from `README.md` near Mobile API Documentation.
- Keep both guides structurally equivalent: identical section order, endpoint
  coverage, tables, diagrams, code blocks, examples, warnings, and acceptance
  checklist. Translate explanatory prose only; preserve every API path, type,
  field, state, error code, close code, command, and JSON value exactly.
- Treat `docs/mobile-integration-guide.en.md` as the canonical specification
  source and `docs/mobile-integration-guide.zh-CN.md` as its strict Simplified
  Chinese translation. Resolve any discrepancy against current production
  code/OpenAPI/SDK first, update the English source, and then synchronize the
  Chinese version.
- Treat the two language files as one coupled deliverable, not independently
  evolving documentation. A behavior change is incomplete until both versions
  are updated and cross-checked.
- Treat the generated OpenAPI document and pinned Claude SDK types as schema
  sources. Do not duplicate every REST schema by hand or create mobile-only
  variants that can drift.
- State the backend version assumptions and how the mobile team should react to
  future OpenAPI or Claude SDK version changes.
- Use exact endpoint, field, event, state, error, close-code, and SDK type names
  from current production code. Clearly label frontend recommendations versus
  required wire contracts.
- Keep the guide platform-neutral. Examples may use HTTP requests, WebSocket
  frames, JSON, language-neutral pseudocode, tables, and sequence diagrams, but
  must not prescribe Expo, React Native, Flutter, Swift, Kotlin, a networking
  library, secure-storage package, or application architecture.

### Pairing and Authentication

- Document QR payload consumption, device registration, local approval,
  claim-challenge signing, credential claim, access-token use, refresh
  challenge/proof, credential rotation, expiry, revocation, and refresh reuse.
- Explain which bootstrap endpoints are public and which HTTP/WebSocket
  operations require the opaque access credential as a Bearer token.
- Include mobile credential-storage and Ed25519 key-ownership requirements
  without exposing real credentials in examples.

### Workspace, Session, and Runtime Flow

- Give one canonical screen flow: authenticated device -> authorized workspace
  list -> Claude session list or New conversation -> history page -> internal
  task attach/create -> raw SDK WebSocket -> composer controls -> Send.
- Explain `GET /v1/workspaces`, session listing, new conversation, session
  attachment, history, and the internal task handle returned by these flows.
- State that task creation/selection/resume is not presented as a user-facing
  conversation step even though `taskId` remains required for backend routing.
- Include a precise identity table for `taskId`, `sdkSessionId`, SDK message
  `uuid`, `new_conversation_id`, approval `requestId`, event cursor, and
  `operationId`.

### History and Live Transcript

- Document the latest 50-message history page, `beforeUuid` upward pagination,
  `includeSystemMessages`, chronological display, stale-cursor recovery, and
  virtualized rendering expectations.
- Keep historical `SessionMessage` and live `SDKMessage` shapes distinct.
  Explain append/prepend behavior and SDK-UUID deduplication at the
  history/live handoff.
- State that the mobile client must not replay history into a prompt or create
  a second canonical transcript.

### Dual WebSockets and Reconnection

- Specify handshake authentication, subscription/open order, inbound and
  outbound frame ownership, `afterUuid`, control `afterCursor`, replay limits,
  close codes, cleanup, and reconnect behavior for both WebSockets.
- Require the mobile client to establish the raw SDK subscriber before
  activating a new or resumed session so the original `system/init` is not
  missed.
- Include representative JSON frames validated against the current runtime
  schemas and SDK types; never wrap raw SDK messages in PocketPilot envelopes.

### Task State, Controls, and Approval

- Explain `idle`, `executing`, `awaiting_approval`, `interrupted`, and
  `terminal`, including allowed UI actions and how disconnect differs from
  interrupt or close.
- Document model, permission-mode, and effort discovery/control, the ordering
  requirement between a control change and the next Send, and raw
  `system/init`/`system/status` authority.
- Document `approval.requested`, complete SDK `PermissionResult` submission,
  stale approval behavior, interrupt cancellation, and close behavior.
- Preserve the established P0-P3 runtime priority and raw SDK
  `priority`/`shouldQuery` passthrough semantics; do not invent mobile-side
  backend priority rules.

### Command Panel and New Conversation

- Document the fixed panel commands and exact argument UI:
  `/compact`, `/context`, `/usage`, `/rename`, `/recap`, `/review`,
  `/security-review`, and `/code-review`.
- Do not duplicate `/cost`, `/stats`, or `/name` aliases as panel rows.
- Limit the `/code-review` panel to optional default/`low`/`medium`/`high`/
  `xhigh`/`max` effort and optional target. Do not expose `ultra`, `--fix`, or
  `--comment`; manually typed raw slash input remains unrestricted.
- Show how a selected panel entry becomes the `content` of an ordinary raw
  `SDKUserMessage`; do not document a nonexistent slash-command HTTP API.
- Reserve `/clear`, `/reset`, and `/new` for the dedicated same-workspace New
  conversation action. State that `/clear` does not itself interrupt active
  work: stop/settle first when needed, then send it through the raw SDK input.
- On raw `conversation_reset`, retain `taskId`, Query, sockets, approval/event
  ownership, and controls; switch the mobile transcript to
  `new_conversation_id`, clear title/transcript cache, and keep the old Claude
  session resumable.

### Errors, Security, and Examples

- Include an error/action matrix for authentication, workspace policy,
  capacity, unavailable/interrupted/terminal task, stale history cursor, stale
  approval, unsupported control, replay limit, SDK transport failure, and
  command-unavailable output.
- Reiterate that authorized roots constrain initial cwd but are not a
  filesystem sandbox, and that PocketPilot never exposes Claude credentials or
  settings contents.
- Include implementation sequence diagrams for pairing, opening history,
  creating/attaching a conversation, Send/live output, approval, reconnect,
  control-before-Send, and New conversation.
- Provide copyable example payloads with synthetic UUIDs, paths, prompts,
  tokens, and keys only. Examples must contain no real local data or secrets.

## Acceptance Criteria

- [ ] Both `docs/mobile-integration-guide.en.md` and
      `docs/mobile-integration-guide.zh-CN.md` give a mobile implementer a
      complete path from pairing through conversation use and recovery without
      requiring undocumented backend knowledge.
- [ ] The English and Chinese guides have matching section structure, endpoint
      coverage, tables, diagrams, examples, warnings, and technical identifiers;
      neither language version contains unique behavioral requirements.
- [ ] Every documented REST operation and payload points to or matches the
      current generated OpenAPI contract; no local `/admin/*` or
      `/_internal/*` route is presented as mobile-accessible.
- [ ] Both WebSocket protocols, raw SDK ownership, authentication, replay,
      reconnection, close codes, and representative frames are accurate.
- [ ] The identity model prevents `taskId`, `sdkSessionId`, message UUID,
      conversation ID, event cursor, approval request ID, and operation ID from
      being conflated.
- [ ] Session history pagination, virtualization, history/live separation, and
      deduplication behavior are directly implementable.
- [ ] Task states, approvals, controls, priority, disconnect, interrupt, close,
      and shutdown behavior match the current backend.
- [ ] The fixed eight-command panel and `/clear` flow match the approved SDK
      contract without describing a slash-specific backend endpoint.
- [ ] All endpoint, error, close-code, command, and sequence examples have been
      checked against production source, tests, generated OpenAPI, and the
      pinned Claude SDK declarations.
- [ ] `README.md` links to both labeled language versions, Markdown links
      resolve, examples contain no secrets, and `pnpm lint`, `pnpm typecheck`,
      `pnpm test`, and `pnpm build` still pass.

## Out of Scope

- Implementing or restructuring the separate mobile application.
- Adding or changing backend routes, storage, runtime behavior, SDK wrappers,
  command discovery, or command parsing solely for this document.
- Replacing generated OpenAPI with a handwritten API specification.
- Teaching local administration UI implementation or tunnel/TLS setup beyond
  the mobile connection assumptions needed for integration.
