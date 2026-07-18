# Research - Real Claude SDK integration tests

## Existing Evidence

- `test/claude-sdk/live-contract.test.ts` is gated by
  `CLAUDE_SDK_LIVE=1`, opens the production wrapper with `query`, and currently
  uses `process.cwd()`. It verifies init, models, two turns, controls,
  interrupt, and close in one 60-second test.
- Default `pnpm test` skipped that file in the latest quality run, confirming
  that the normal suite is offline but also that no real SDK contract was
  exercised.
- `src/claude-sdk/session.ts` owns the production long-lived input stream,
  unchanged SDK event generator, session-ID observation, initialization,
  model/mode/effort controls, interrupt, and close.
- `src/claude-sdk/session-catalog.ts` wraps only public SDK session APIs and is
  the production catalog used by `TaskManager`.
- `TaskManager.attachClaudeSession()` reuses the non-terminal owner for a real
  SDK session, `activateSdkSession()` opens the resumed Query,
  `getComposerOptions()` initializes the real Query, and task events publish
  SDK messages unchanged through `TaskEventSink`.
- Existing task-manager fixtures prove the SQLite/settings/device setup needed
  by a real test, but inject fake SDK sessions. The live fixture can use an
  in-memory Agent database and the production session factory instead.
- The supplied local development workspace exists and contains local Claude
  settings. The test does not need and must not read those settings; it passes
  only the workspace path to public SDK APIs.

## Configuration Decision

- Public developer input: `CLAUDE_SDK_TEST_CWD` process environment value.
- Internal runner flag: `CLAUDE_SDK_LIVE=1`, set by the dedicated runner so the
  ordinary test command remains skipped and the live command cannot silently
  do nothing.
- A test configuration helper canonicalizes and validates the path only when
  live mode is enabled. Missing, relative, nonexistent, and non-directory
  values fail before `query()` runs without echoing local path values.
- Do not add the test variable to `.env.example`: that file is the Agent
  startup allowlist contract, while this is an explicit developer process
  environment input.

## Minimum Real-SDK Scenario

1. Open one production `ClaudeSdkSession` in safe `plan` permission mode.
2. Submit two synthetic no-tool marker prompts on the same input stream and
   observe raw init/result boundaries plus a stable SDK session ID and model
   catalog.
3. Interrupt/close the direct Query in `finally`.
4. Wait for the public SDK session catalog to expose that session.
5. Build a real `TaskManager` with an in-memory Agent database, the supplied
   workspace root, and a recording event sink.
6. Attach the existing session, activate its resumed Query, obtain composer
   options, and submit one `shouldQuery: false` marker to start raw event
   delivery without starting a model turn.
7. Observe the resumed Query's unchanged `system/init`, apply
   model/plan-mode/null-effort controls, then submit the third query-triggering
   marker; observe executing/idle state and raw SDK result publication.
8. Read history through `TaskManager`, verify the same session identity, invoke
   idle interrupt, and always run manager shutdown/database close.

This consumes approximately three model turns and leaves one intentionally
persistent, clearly marked Claude test session. It does not invoke tools or
modify workspace files.

## Live Findings

- `supportedModels()` is a non-empty composer catalog, but the active model in
  `system/init.model` can come from local Claude configuration and need not be
  one of the catalog values. Live model-control assertions must set the active
  init model rather than switching to the first catalog entry.
- On a resumed streaming Query, `initializationResult()` and
  `supportedModels()` can complete before the SDK message iterator publishes
  `system/init`. The first raw SDK input starts that delivery; using
  `shouldQuery: false` proves the boundary without consuming an extra model
  turn.
- Controls are reliable when ordered after raw init and before the next
  query-triggering message. This matches the successful direct-Query sequence
  and avoids assuming pre-init control timing.
- The live SDK can emit `system/api_retry` and take longer than 90 seconds to
  complete a model boundary. The test reports only safe message categories and
  permits up to 180 seconds per SDK event boundary while retaining a bounded
  ten-minute outer timeout.

## Runner Decision

Use a small Node ESM runner under `scripts/`:

- set `CLAUDE_SDK_LIVE=1` in the child process;
- invoke the installed Vitest CLI through `process.execPath` without a shell;
- run only `test/claude-sdk/live-contract.test.ts`;
- forward stdio and propagate signal/exit status.

This keeps `package.json` readable and works without adding a cross-env
dependency or platform-specific environment syntax.

## Reliability Requirements

- Use explicit per-event/retry deadlines so a failed SDK response rejects
  inside the test body and executes `finally`; do not rely only on Vitest's
  outer timeout.
- Keep prompts content-independent and assert protocol metadata/state rather
  than exact assistant prose.
- Run the live suite sequentially and use one scenario to avoid duplicate
  persistent sessions and excess model turns.
- Never snapshot or print raw messages, history bodies, local settings, or
  credentials.
