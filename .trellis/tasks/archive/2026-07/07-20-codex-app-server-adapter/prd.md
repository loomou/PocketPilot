# Codex App Server adapter

## Goal

Add Codex CLI as a first-class PocketPilot provider through the official local
`codex app-server` stdio JSON-RPC protocol while preserving Codex-native thread,
turn, item, streaming, approval, sandbox, and error semantics.

## Dependencies

- Blocking dependency: `07-20-agent-api-claude-migration` must first establish
  and verify `AgentProviderAdapter`, provider-aware persistence, provider-nested
  conversation routes, and `/v1/tasks/{taskId}/agent`.
- The parent research file
  `07-19-remote-codex-cli/research/codex-app-server-vs-claude-sdk.md` is the
  evidence baseline for protocol and capability decisions.
- This task must extend the common contract through capabilities or
  provider-specific schemas, not by adding Codex branches to common modules.

## Requirements

### App Server bridge

- Spawn `codex app-server --listen stdio://` locally with piped stdin/stdout and
  diagnostic stderr capture.
- Implement JSONL parsing, JSON-RPC correlation, initialize/initialized
  handshake, bounded writes, deterministic shutdown, and version negotiation.
- Do not use Codex SDK, MCP server, PTY scraping, keyboard simulation, or direct
  App Server WebSocket as the primary control path.

### Conversation and turn lifecycle

- Implement `thread/list`, `thread/read`, `thread/start`, and `thread/resume`.
- Include CLI, VS Code, and App Server thread sources and apply canonical
  descendant workspace authorization to every returned or requested cwd/root.
- Bind PocketPilot `taskId` separately from Codex thread/session/turn/item and
  JSON-RPC request IDs.
- Route idle input to `turn/start`, active input to
  `turn/steer(expectedTurnId)`, and interrupt to
  `turn/interrupt(threadId, turnId)`.

### Native events and approvals

- Send allowlisted Codex-native JSON-RPC frames on the task stream without a
  common payload wrapper or Claude translation.
- Retain an out-of-band PocketPilot reconnect cursor without modifying native
  frames.
- Support multiple concurrent server requests with request-scoped approval
  ownership, expiry, replay, and resolution.
- Preserve native Codex approval decisions, permission amendments, errors, turn
  status, and item types.

### Capabilities and validation

- Obtain models and reasoning effort from `model/list` and expose Codex-native
  approval, sandbox, permission, and collaboration controls through declared
  capabilities.
- Fail closed on unsupported versions, unknown privileged methods, or
  unauthorized paths.
- Add caller-configured live tests; never hardcode a developer workspace,
  executable path, account, credential, or generated-schema temp path.

## Acceptance Criteria

- [ ] PocketPilot starts and initializes App Server exactly once and shuts it
  down without leaking the process or pending requests.
- [ ] Authorized Codex CLI, VS Code, and App Server threads can be listed, read,
  started, resumed, and attached through the common Agent API.
- [ ] Native streamed agent deltas, final items, turn states, errors, and
  concurrent approvals reach only the owning authenticated task.
- [ ] Start, steer, interrupt, reconnect, stale cursor, bridge exit, workspace
  revocation, and shutdown behavior pass focused tests.
- [ ] Model, effort, approval, sandbox, permission, and collaboration options
  are capability-driven and never borrowed from Claude enums.
- [ ] A live test using `CODEX_APP_SERVER_TEST_CWD` proves initialization, new
  thread ID allocation, streaming, approval or sandbox behavior, interrupt,
  history, resume, source visibility, and clean shutdown.
- [ ] Existing Claude provider tests remain unchanged and pass.

## Out of Scope

- Direct App Server exposure to the LAN.
- Codex account login, configuration writes, plugin installation, external Agent
  import, arbitrary filesystem/process APIs, or arbitrary MCP calls.
- Compatibility routes for the removed Claude API.
- OpenCode or Pi adapter implementation.
