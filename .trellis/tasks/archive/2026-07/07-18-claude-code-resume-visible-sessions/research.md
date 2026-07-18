# Research - Claude Code resume-visible PocketPilot sessions

## Confirmed Installed Behavior

- The repository pins `@anthropic-ai/claude-agent-sdk@0.3.210`; the installed
  Claude Code CLI reports `2.1.190`.
- `query()` launches Claude Code in streaming/print mode. Its installed runtime
  copies `Options.env` and sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` only when that
  variable is not already present.
- The installed session catalog classifies exactly `sdk-cli`, `sdk-ts`, and
  `sdk-py` entrypoints, plus daemon session kinds, as programmatic/headless.
- `ListSessionsOptions.includeProgrammatic` documents that terminal `/resume`
  excludes programmatic sessions. PocketPilot deliberately passes
  `includeProgrammatic: true`, which is why its own catalog sees SDK-created
  sessions that terminal `/resume` omits.
- `Options.env` is a public SDK option for the spawned Claude Code process, but
  `CLAUDE_CODE_ENTRYPOINT` is not documented in the public TypeScript
  declarations or package README.
- Neither `Options` nor `claude --help` exposes a public entrypoint option. CLI
  flags cover `--session-id`, `--resume`, `--continue`, and
  `--fork-session`, but not provenance/visibility.
- Public session mutation APIs can rename, tag, fork, or delete sessions. None
  reclassifies an existing session's entrypoint.

## Existing PocketPilot Boundary

- `openClaudeSdkSession()` supplies cwd/model/mode/resume/tool approval only;
  it currently inherits the process environment implicitly.
- New PocketPilot conversations open one ordinary SDK Query with cwd only.
  Existing selected sessions open the same Query with `Options.resume`.
- TaskManager/session catalog/history depend on public Agent SDK types and raw
  message passthrough. Replacing Query with terminal-screen automation would
  discard these contracts and require a second parser/control protocol.

## Options Considered

### 1. Custom PocketPilot entrypoint through `Options.env` (selected)

Pass the inherited environment plus
`CLAUDE_CODE_ENTRYPOINT=pocketpilot` only when PocketPilot opens a new SDK
Query. Resume Queries keep the selected session ID and receive no PocketPilot
entrypoint override. The custom value truthfully identifies the creating host
instead of pretending to be the terminal. Under the pinned catalog rule, the
new session is not in the three SDK programmatic entrypoints and therefore
appears under terminal `/resume` semantics.

Benefits:

- Retains the Agent SDK Query, raw types, controls, approvals, history, and
  resume behavior.
- Requires a narrow adapter change and can be verified against the pinned
  runtime with a real integration test comparing `includeProgrammatic: true`
  and `false`.
- Uses a distinct provenance value rather than spoofing `cli`.

Risks:

- `CLAUDE_CODE_ENTRYPOINT` is an installed-runtime contract, not a documented
  SDK option. An SDK/CLI upgrade could change the variable or terminal filter.
- New-conversation Queries use the PocketPilot classification. Resume Queries
  preserve the selected session ID/provenance and do not request a fork or new
  classification; tests must fail visibly if the pinned behavior changes.
- Existing `sdk-ts` sessions cannot be converted through a supported mutation
  API and remain hidden from terminal `/resume`.

### 2. Launch interactive Claude Code through a PTY

This would create a terminal-owned session, but PocketPilot would need to parse
ANSI terminal UI, synthesize keyboard input, and reimplement model/mode/effort,
approval, raw events, and history boundaries. It conflicts with the project's
SDK-alignment contract and is not a viable incremental change.

### 3. Use Claude Code Remote Control

The installed CLI exposes `--remote-control`, but it is a separate Claude Code
remote product flow, not the Agent SDK Query transport used by PocketPilot. It
does not provide a documented replacement for PocketPilot's authenticated
mobile API and raw SDK WebSocket. Adopting it would be an architecture/product
replacement rather than a session-visibility fix.

### 4. Rewrite Claude session metadata

Rejected. It depends on private transcript format, falsifies provenance, risks
corruption, and violates the existing rule that PocketPilot never parses or
edits `~/.claude`.

## Verification Shape

- Offline unit test that the session adapter supplies an inherited environment
  with the exact PocketPilot entrypoint and does not mutate `process.env`.
- Real test creates a marked no-tool session in a developer-provided workspace,
  then proves the same session ID appears in both:
  - SDK catalog with `includeProgrammatic: true`;
  - SDK catalog with `includeProgrammatic: false`, which the installed SDK
    documents as terminal `/resume` parity.
- Continue the same session through TaskManager and recheck history/session
  identity so visibility does not create a second conversation.
- Do not automate or parse the terminal picker itself unless catalog parity is
  proven insufficient on the pinned Claude Code version.

## Product Decisions

- Accept the pinned, integration-tested `CLAUDE_CODE_ENTRYPOINT` environment
  contract with the truthful value `pocketpilot` for new conversations only.
- Never use the terminal `cli` value and never rewrite Claude-owned session
  files.
- Resume every selected session under the same `sdkSessionId` without a fork or
  reclassification. A terminal-created session therefore keeps its identity
  and terminal visibility after PocketPilot continuation.
- Existing hidden `sdk-ts` sessions remain PocketPilot-only; there is no
  migration against private Claude storage.
