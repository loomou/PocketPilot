# Design - Real Claude SDK integration tests

## Scope and Boundaries

This task adds an explicit developer-run live test lane. It validates the
production Claude SDK wrapper and `TaskManager` against the installed Claude
Code process, while existing deterministic tests continue to own auth, REST,
WebSocket framing, replay, storage, and failure matrices.

No production API, task behavior, storage schema, SDK wrapper, or startup
environment contract changes. The developer-supplied workspace is runtime
input only.

## Files and Ownership

| File | Responsibility |
| --- | --- |
| `test/claude-sdk/live-test-config.ts` | Pure live-mode and workspace validation helper |
| `test/claude-sdk/live-test-config.test.ts` | Offline coverage for disabled/missing/invalid/valid configuration |
| `test/claude-sdk/live-contract.test.ts` | One serial real SDK wrapper + TaskManager scenario |
| `scripts/run-claude-sdk-live-tests.mjs` | Dedicated runner that enables live mode and invokes only the live test |
| `package.json` | `test:sdk:live` developer command |
| `README.md` | Process-environment usage, prerequisites, cost/session side effects |

## Configuration Contract

```text
CLAUDE_SDK_TEST_CWD=<absolute existing directory>
pnpm test:sdk:live
```

The runner supplies `CLAUDE_SDK_LIVE=1` only to its Vitest child. The test
configuration helper returns a disabled result when live mode is absent. When
enabled, it trims, validates absolute-path syntax, canonicalizes with
`realpathSync`, and verifies `statSync(...).isDirectory()` before the suite
constructs a Query.

Errors name only `CLAUDE_SDK_TEST_CWD` and the violated requirement; they do
not echo configured or resolved paths. The canonical path is held in memory
and passed as `cwd`/workspace but never logged or snapshotted.

## Live Scenario Data Flow

```text
developer env cwd
  -> live config validation
  -> openClaudeSdkSession({ cwd, permissionMode: "plan" })
  -> Query turn 1 -> raw init/result -> observed sessionId
  -> Query turn 2 -> raw result -> interrupt/close
  -> installedClaudeSessionCatalog.getInfo(sessionId, { dir: cwd })
  -> TaskManager.attachClaudeSession(sessionId, workspace: cwd)
  -> activateSdkSession -> resumed real Query -> composer options
  -> shouldQuery:false -> raw init
  -> composer controls -> query-triggering turn 3
  -> raw result/task idle -> TaskManager history -> interrupt -> shutdown
```

The direct and manager phases deliberately share one persistent session. The
test uses each Query's raw `system/init.model` when exercising `setModel`, since
a locally configured active model is not required to appear in
`supportedModels()`. It asserts SDK/task identities and event/state boundaries,
not exact output text.

## Test Fixture

The TaskManager phase uses:

- `openStorage({ databasePath: ":memory:" })`;
- one synthetic device row for metadata-only audit foreign keys;
- `SettingsRepository` plus `writeTaskRuntimeSettings()` with the canonical
  supplied workspace and enough capacity;
- production session factory and production installed catalog by omitting
  injected fakes;
- a recording `TaskEventSink` for raw SDK messages and control state.

Cleanup order is manager shutdown, SQLite close, then timer disposal. Direct
Query cleanup calls interrupt best-effort and close in `finally`. Explicit
deadline helpers ensure cleanup executes before Vitest's outer timeout.

## Safety Model

- All prompts start with `POCKETPILOT_LIVE_TEST`, request a short marker-only
  response, and prohibit tool use.
- Direct Query starts in `plan`; resumed TaskManager Query is set to `plan`
  before its query-triggering input.
- No approval is automatically granted. An unexpected approval causes the
  bounded wait to fail and shutdown cancels it.
- The supplied workspace is never written by test code.
- One SDK session intentionally remains in Claude history; no `.claude` file is
  read, edited, or deleted.

## Runner and Exit Semantics

The ESM runner locates `vitest/package.json`, derives the sibling
`vitest.mjs`, and spawns it with `process.execPath`. It forwards stdio, passes
the current environment plus `CLAUDE_SDK_LIVE=1`, and propagates nonzero exits
and termination signals. No shell interpolation is used.

## Compatibility

- Keep `CLAUDE_SDK_LIVE=1` as the internal gate so direct advanced invocation
  remains possible, but document only `pnpm test:sdk:live`.
- Keep default `pnpm test` behavior unchanged and offline.
- SDK-version-dependent message unions remain owned by installed TypeScript
  declarations; the live test uses type narrowing and open matching.

## Rollback

Remove the runner, command, config helper/tests, README instructions, and live
scenario changes together. No production state or migration rollback is
required. The intentionally created Claude test session may remain as ordinary
SDK-owned local history.
