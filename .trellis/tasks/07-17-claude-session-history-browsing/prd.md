# Claude Session History Browsing

## Goal

Let a remote authenticated user choose an authorized workspace, start a new
Claude conversation or browse every Claude Code session that the installed
Claude Agent SDK exposes for that workspace, and work in the selected/new
session through a desktop-style conversation UI.

## Background

- `GET /v1/workspaces` returns configured authorized workspace roots.
- `GET /v1/tasks` lists PocketPilot runtime metadata, not directory-scoped
  Claude Code sessions.
- `POST /v1/tasks` can create a new Query runtime, but it requires the client to
  participate in PocketPilot task creation and supply initial controls. The new
  workspace flow must reuse that runtime machinery behind a Claude-session UI
  rather than expose the task workflow.
- PocketPilot currently cannot bind a newly created task to an arbitrary
  discovered SDK session and permits repeated `sdk_session_id` values.
- The installed `@anthropic-ai/claude-agent-sdk@0.3.210` bundles Claude Code
  `2.1.210`. It is the source of truth for session, history, live message,
  model, permission-mode, and effort contracts.
- PocketPilot tasks remain useful as internal owners of a long-lived Query,
  approvals, capacity, interruption, replay, and shutdown. They are not a user
  conversation concept and must not appear as a step in the mobile workflow.
- The intended interaction matches desktop coding clients: selecting a Claude
  session opens its conversation screen, renders history, and leaves the bottom
  composer ready. "Continue session" is not a separate action or state.

## Requirements

### Session discovery and history

- A request supplies a workspace selected from the existing authorized policy
  surface. Canonicalize and authorize it before any SDK discovery, history, or
  attachment call.
- Use only supported SDK APIs. Do not locate or parse Claude session files:
  - `listSessions({ dir, limit, offset, includeWorktrees,
    includeProgrammatic })`
  - `getSessionInfo(sessionId, { dir })`
  - `getSessionMessages(sessionId, { dir, limit, offset,
    includeSystemMessages })`
- List SDK-discoverable sessions created both inside and outside PocketPilot.
  Include programmatic/headless sessions for the explicit "all sessions"
  scope.
- Set `includeWorktrees: false`. The SDK default can enumerate git worktrees
  outside the selected authorized root; present returned `cwd` values must also
  pass policy checks before their metadata is delivered.
- Preserve every returned `SDKSessionInfo` object and support SDK
  `limit`/`offset` pagination without inventing a total count.
- Validate a selected session with `getSessionInfo(sessionId, { dir })` before
  returning history or attaching a runtime. An empty `getSessionMessages()`
  result must not make a missing session appear valid.
- Return the SDK's chronological `SessionMessage[]` values unchanged. Support
  an explicit `includeSystemMessages` option and a bounded, latest-first remote
  history page rather than returning the entire conversation to the client.
- The initial history response contains the latest 50 filtered messages in
  chronological order. Loading older history uses the earliest loaded SDK UUID
  as an out-of-band `beforeUuid` cursor and prepends at most 50 earlier
  messages. The cursor and page metadata must never be added to an SDK message.
- If a `beforeUuid` is no longer present in the SDK's current conversation
  chain, return a stable stale-cursor error so the client can reload the latest
  page. Keep `includeSystemMessages` consistent across one cursor sequence.
- Serialize history reads for the same session and retain no full transcript
  cache between requests. The installed SDK reads/parses the full transcript
  and reconstructs its parent chain before applying pagination, so bounded
  pages protect network/mobile rendering but cannot remove local parse cost.
- History loading is independent from runtime attachment. A slow or failed
  history read shows a retryable history error but must not block raw SDK
  connection, composer controls, or continued conversation.
- Do not create a PocketPilot transcript projection or merge historical
  `SessionMessage` and live `SDKMessage` shapes on the Agent.

### Desktop-style conversation flow

- The workspace page always offers **New conversation** alongside historical
  sessions. A workspace with no historical session must still be immediately
  usable.
- Choosing New conversation opens the same conversation screen with empty
  history and transparently creates an internal runtime whose Query has the
  authorized cwd and no `Options.resume` value.
- A new conversation starts with Claude Code's own resolved model, permission,
  and effort defaults. PocketPilot must not require the user to choose controls
  first or inject its own defaults; the user can change the live selectors
  after the SDK reports initialization.
- Selecting a session immediately opens its conversation screen and loads its
  history. The page keeps a bottom composer with a text input, Claude model
  selector, Claude permission-mode selector, Claude reasoning-strength
  selector, and send icon.
- Opening the screen transparently creates, attaches, or reuses exactly one
  non-terminal internal runtime for the selected Claude session and opens its
  Query with `Options.resume`. No task creation, task selection, task resume,
  or "continue session" control is shown to the user.
- An interrupted internal runtime may be transparently reattached without
  replaying a prompt. Two PocketPilot Queries must never own the same Claude
  session concurrently.
- Raw SDK subscription must be established before an attached Query is
  activated, for both new and resumed conversations, so the client receives the
  original SDK `system/init` object. For a new conversation, its
  `system/init.session_id` becomes the SDK session reference persisted by the
  internal runtime and exposed on the unchanged raw stream.
- Pressing Send submits only the raw `SDKUserMessage` through the selected
  session's existing long-lived Query. It must continue that transcript rather
  than create an unrelated Claude session.
- History and live output remain separate SDK-owned data sources. A client may
  deduplicate/refetch by SDK UUID around the history-to-live handoff; the Agent
  must not solve that race by persisting a second transcript or adding fields
  to SDK messages.
- The mobile conversation view must render history through a virtualized list,
  prepend older pages on upward scroll, append live SDK output, and deduplicate
  by SDK UUID where available rather than mounting every historical message at
  once.

### Claude Code controls

- Model choices come from `Query.supportedModels()`. Per-model reasoning
  choices come from `ModelInfo.supportedEffortLevels`. Permission modes come
  from the pinned SDK `PermissionMode` contract, not a mobile hard-coded list.
- Use raw SDK `system/init` and `system/status` as the authoritative source for
  the resumed Query's model and permission mode. SDK-resolved settings may
  supply the initial effort/default state without exposing unrelated Claude
  configuration.
- When the user changes a selector, immediately call the live Query control and
  wait for its success/error before treating the value as active:
  - model: `setModel()`
  - permission mode: `setPermissionMode()`
  - effort: `applyFlagSettings()`
- Match Claude Code/SDK timing: accepted controls update the running session
  without restarting it and apply on the next turn. They do not rewrite the
  current in-flight turn.
- Preserve command-before-prompt ordering. A selector change followed by Send
  must behave like completing `/model`, a permission-mode switch, or `/effort`
  before entering the next prompt in Claude Code.
- The installed SDK has no `setEffort()` method.
  `setMaxThinkingTokens()` is deprecated thinking configuration and is not a
  substitute for named effort. Although generated persisted
  `Settings.effortLevel` declares `low`, `medium`, `high`, and `xhigh`, the
  SDK's `EffortLevel`, per-model catalog, and documented live control can also
  support session-only `max`; isolate that declaration/runtime boundary inside
  the SDK adapter.
- Claude Code owns model validation, permission policy, effort fallback, and
  settings persistence. PocketPilot must not restart the Query, silently
  substitute values, implement its own model/effort fallback, or write Claude
  settings files.
- Send never carries a PocketPilot-owned model/mode/effort bundle. It carries
  only the raw SDK user message after any requested control operation has
  completed.

### Existing boundaries and integration contract

- Keep Bearer device authentication, workspace-scope acknowledgement, task
  capacity, control events, raw SDK transport, approval handling, interruption,
  shutdown, and device revocation behavior intact.
- Attaching an idle session does not consume an active-turn capacity slot; the
  first query-triggering message still enforces the configured capacity.
- Do not persist or log session summaries, prompts, history, live messages,
  tool content, or a second canonical transcript in PocketPilot SQLite, task
  rows, audit records, idempotency results, or application logs.
- Document the session catalog, history, transparent attachment, composer
  controls, pagination, security, and exact SDK-version ownership in the
  generated mobile OpenAPI contract.
- Make the change directly in the unpublished `/v1`; retain the existing raw
  SDK WebSocket and control-only WebSocket separation.

## Technical Notes

- `listSessions({ dir })` includes worktrees by default and
  `includeProgrammatic` defaults to true. This feature passes both choices
  explicitly to make the security and product scope stable across upgrades.
- `getSessionMessages()` constructs the chronological conversation chain and
  returns an empty array for both missing and empty sessions, which is why
  `getSessionInfo()` validation is mandatory. In SDK `0.3.210`, it reads and
  reconstructs the full chain before slicing `offset`/`limit`; the public
  PocketPilot cursor therefore bounds transport/UI work, not SDK parse work.
- Viewing history does not replay it into the model. Continuing uses
  `Options.resume`, leaving context-window management and compaction entirely
  to Claude Code.
- `Options.resume` is the supported continuation mechanism.
- The official SDK reference documents `setModel()`, `setPermissionMode()`,
  and `applyFlagSettings()` as streaming-input controls on an existing Query;
  live settings take effect on the next turn.
- Claude.ai Remote Control exposes a narrower three-mode product menu for local
  sessions. PocketPilot is an SDK host and must not copy that surface-specific
  allowlist over the SDK `PermissionMode` contract.

## Acceptance Criteria

- [ ] An authenticated client can list SDK-discoverable sessions for an
      authorized workspace, including sessions not created by PocketPilot and
      the requested programmatic-session scope.
- [ ] Unauthorized, nonexistent, symlink-escaped, worktree-outside-policy, or
      otherwise out-of-policy directories/session cwd values cannot expose
      session metadata or history.
- [ ] The client can read a validated session's chronological history using
      unchanged SDK-owned shapes, latest-first 50-message pages,
      `beforeUuid` upward pagination, and optional system messages.
- [ ] A stale history cursor produces a stable retryable error, and concurrent
      history reads for one session do not trigger uncontrolled parallel full
      transcript parses.
- [ ] Slow or failed history loading does not prevent runtime attachment,
      composer readiness, raw live messages, or sending the next prompt.
- [ ] Selecting a session opens a desktop-style conversation page, loads
      history, and shows the bottom composer without a PocketPilot task or
      "continue session" control.
- [ ] Every authorized workspace offers New conversation; selecting it opens
      the same page with empty history and starts a Query using Claude Code's
      local defaults without `Options.resume`.
- [ ] Selection transparently attaches or reuses one internal runtime, resumes
      the selected SDK session, and delivers the original raw `system/init`
      after the raw socket subscribes.
- [ ] Entering text and pressing Send submits an unchanged raw SDK user message
      and either continues the selected transcript or creates the intended new
      transcript, without an unrelated extra session.
- [ ] The UI can discover SDK-owned models, permission modes, and per-model
      effort levels and initialize its controls from SDK state.
- [ ] Model, permission-mode, and effort changes update the existing Query,
      affect the next turn, work while another turn is active, and never
      recreate the Query or ride inside the Send payload.
- [ ] SDK control rejection and Claude-owned fallback/status reach the client
      without PocketPilot substitution or config-file mutation.
- [ ] One non-terminal internal runtime at most owns a Claude session; idle
      attachment uses no execution-capacity slot.
- [ ] Session/history/live content is absent from PocketPilot durable storage,
      audit/idempotency records, and logs.
- [ ] OpenAPI, migration, unit, route, raw/control isolation, SDK contract,
      security, build, deterministic package, and Windows release validation
      pass.

## Out of Scope

- Parsing `~/.claude` JSONL or any other Claude-owned session file directly.
- Persisting, editing, full-text searching, or projecting Claude transcript
  content in PocketPilot.
- Reimplementing Claude Code's model validation, permission policy, effort
  fallback, settings persistence, or rendering behavior.
- Exposing PocketPilot task management as part of the session conversation UI.
- Adding Claude Code features outside the requested model, permission-mode, and
  reasoning-strength composer controls (for example ultracode/workflow toggles).
- Exposing Slash Commands, Skills, Agents, MCP server/tool status, context
  usage, background-task status, or account details. These Query-scoped
  capabilities are explicitly deferred to later tasks.
