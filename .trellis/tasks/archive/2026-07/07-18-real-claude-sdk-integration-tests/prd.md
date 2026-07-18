# Real Claude SDK integration tests

## Goal

Provide explicit opt-in integration tests that run PocketPilot against the
installed, authenticated Claude Code/Agent SDK in a developer-supplied
workspace, so critical production assumptions are verified with the real SDK
without making normal unit tests network-dependent or hardcoding one computer's
directory.

## Background

- The project pins `@anthropic-ai/claude-agent-sdk@0.3.210` and has extensive
  mocked/unit coverage for SDK input, session, catalog, task-manager, and
  WebSocket boundaries.
- `test/claude-sdk/live-contract.test.ts` is the only current real-SDK test. It
  runs only when `CLAUDE_SDK_LIVE=1`, uses `process.cwd()` as Claude `cwd`, and
  covers initialization, model discovery, two turns on one input stream, live
  model/permission controls, interrupt, and close.
- The default `pnpm test` run skips that test; it does not prove that the
  current computer can launch and communicate with Claude Code.
- The user supplied a local workspace for this development run. It contains
  local Claude configuration, but its concrete path and configuration contents
  must not be copied into source, fixtures, snapshots, documentation, or logs.
- A developer running the live tests must already have Claude Code installed
  and authenticated for the current operating-system account.

## Requirements

### Opt-in and workspace configuration

- Keep all real-SDK tests excluded from ordinary `pnpm test` behavior unless a
  developer explicitly opts in.
- Require the live workspace through one documented process environment value;
  the recommended name is `CLAUDE_SDK_TEST_CWD`.
- When live mode is enabled, fail early with a safe, actionable error if the
  workspace variable is absent, relative, nonexistent, or not a directory.
- Do not fall back to `process.cwd()` in live mode and do not commit the
  concrete local development workspace value.
- Provide a dedicated, discoverable command and platform-neutral instructions
  showing a placeholder such as `<absolute-workspace-path>`.
- The dedicated `pnpm test:sdk:live` command must enable live mode internally;
  callers provide only `CLAUDE_SDK_TEST_CWD`. Direct default `pnpm test` keeps
  the live suite skipped.

### Real SDK behavior

- Use the production `openClaudeSdkSession` and installed SDK `query`, not a
  mocked Query, for every live contract assertion.
- Assert metadata and protocol behavior rather than exact model prose. Prompts
  may request deterministic marker text, but a test must not depend on exact
  natural-language output when a raw result/state boundary is sufficient.
- Preserve the production long-lived input stream: at least two user messages
  must be accepted by one Query.
- Verify SDK initialization, a non-empty supported-model catalog, an observed
  SDK session ID, raw result boundaries, and the live controls included in the
  agreed test scope.
- Cover both the production `openClaudeSdkSession` wrapper and the
  `TaskManager` critical path. The TaskManager coverage must prove that a real
  SDK session is activated in the supplied workspace, accepts raw input,
  publishes unchanged SDK output, maintains task state, exposes composer
  options, and performs selected live controls/interrupt cleanup.
- Use one serial scenario and one persistent SDK session for the full contract:
  run two turns through `openClaudeSdkSession`, close that Query, then attach
  and resume the same `sdkSessionId` through `TaskManager` for the third turn.
- Through `TaskManager`, verify an append-only `shouldQuery: false` message,
  model/permission/effort controls ordered before the query-triggering message,
  `executing -> idle` state, raw SDK publication, history access, and an idle
  interrupt/cleanup boundary.
- Use only synthetic prompts and non-sensitive assertions. Do not print raw
  messages, tool inputs, Claude credentials, or local Claude settings.

### Isolation and cleanup

- Treat live tests as serial, bounded, potentially billable integration tests.
- Close every Query in `finally`, and interrupt active work before close when
  cleanup requires it. A timeout or failed assertion must not leave a Claude
  subprocess or input stream running.
- Do not modify project files in the developer-supplied workspace. Any test
  that needs filesystem effects must use its own temporary child directory and
  explicit cleanup, subject to separate approval.
- Do not read or parse `.claude` files directly; exercise only public SDK and
  PocketPilot boundaries.
- Keep the normal offline test suite deterministic and unchanged when live
  environment values are absent.
- Allow approximately three real model turns per complete live run. Every
  prompt must carry an obvious `POCKETPILOT_LIVE_TEST` marker, explicitly tell
  Claude not to use tools, and avoid repository-specific content.
- Allow the live run to leave its SDK-owned test session in Claude's session
  catalog so persistence/history can be asserted. Do not delete or edit
  `.claude` transcript files during cleanup.

## Acceptance Criteria

- [x] No committed production, test, script, documentation, or Trellis file
      contains the concrete local development workspace path.
- [x] A developer can supply an arbitrary absolute workspace directory and run
      the real-SDK suite with one documented command.
- [x] Missing or invalid live-test workspace configuration fails before a Query
      starts and explains how to correct it without revealing other paths.
- [x] Default `pnpm test` remains offline and skips all real-SDK work.
- [x] Live tests use production SDK integration, validate the agreed critical
      path, and reliably close resources on success, failure, and timeout.
- [x] One persistent SDK session spans two direct-wrapper turns and a third
      TaskManager-managed resumed turn, with catalog/history visibility and
      expected task/control state assertions.
- [x] Live assertions avoid exact prose, secrets, settings contents, and
      unintended workspace mutations.
- [x] A full live run uses approximately three model turns and leaves only an
      identifiable SDK-owned test session as its intentional persistent side
      effect.
- [x] `pnpm lint`, `pnpm typecheck`, default `pnpm test`, and the dedicated live
      test command pass in the configured development environment.

## Out of Scope

- Installing or authenticating Claude Code for a developer or CI runner.
- Committing a real workspace path, Claude credential, local `.claude`
  configuration, transcript, or model output.
- Enabling billable/network-dependent SDK tests in the default test suite or
  ordinary CI.
- Testing destructive tools or approving arbitrary filesystem/shell actions in
  the supplied workspace unless the scope is explicitly expanded.
- Running the live contract through device pairing, authenticated HTTP routes,
  or either WebSocket. Those transport boundaries retain their existing
  deterministic integration tests in this task.
