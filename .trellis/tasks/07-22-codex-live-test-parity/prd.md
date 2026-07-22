# Codex live test parity

## Goal

Give the Codex provider a live test that carries the same distinguishing
contract as `test:sdk:live` does for Claude, so the two providers have
comparable live coverage.

## Background (confirmed from code)

- `package.json` already exposes both scripts:
  - `test:sdk:live` → `scripts/run-claude-sdk-live-tests.mjs` (sets
    `CLAUDE_SDK_LIVE=1`, runs `test/claude-sdk/live-contract.test.ts`).
  - `test:codex:live` → `scripts/run-codex-app-server-live-tests.mjs` (requires
    `CODEX_APP_SERVER_TEST_CWD` or `POCKETPILOT_CODEX_LIVE_CWD`, runs
    `test/codex-app-server/live-contract.test.ts`).
- The two live tests are NOT symmetric today:
  - `test:sdk:live` drives the full task lifecycle through `TaskManager`
    (attach → activate → submit multiple turns → resume → interrupt) and its
    distinguishing contract is **two turns on one session, then resume**.
  - `test:codex:live` only drives the raw `CodexAppServerBridge` over JSON-RPC
    and runs a **single turn per thread**. Multi-turn continuity + resume on the
    same thread is the coverage gap.
- Codex does not drive `TaskManager` through Claude-specific methods. It flows
  through a provider-neutral `ProviderTaskRuntime` + `CodexProviderAdapter`.
  A TaskManager-level Codex harness is therefore a much larger effort and is
  out of scope (see decision D1).
- Existing Codex live test already has reusable helpers: `asObject`,
  `requireString`, `waitForNotification`, and the `describeLive` env-var gate.

## Decisions

- D1: Extend the existing bridge-level `test/codex-app-server/live-contract.test.ts`
  rather than build a TaskManager-level Codex harness. (user, 07-22)
- D2: Keep the workspace env-var-only. Do NOT bake in a default workspace such
  as `L:\code\test\js\claude-test`. (user, 07-22)

## Requirements

- R1: Add a live test case to `test/codex-app-server/live-contract.test.ts` that
  runs two turns on one Codex thread and then resumes that same thread, mirroring
  the multi-turn + resume contract that distinguishes `test:sdk:live`.
- R2: Reuse the existing env-var gate (`CODEX_APP_SERVER_TEST_CWD`) and helpers;
  do not add a new run script or new env vars.
- R3: The new case must clean up its thread (archive) and close the bridge in a
  `finally`, matching the surrounding tests' cleanup pattern.

## Acceptance Criteria

- [ ] AC1: `test/codex-app-server/live-contract.test.ts` contains a case that
      starts one thread, completes TURN_1, completes TURN_2 on the same
      `threadId`, and asserts streaming (`item/agentMessage/delta`) occurred on
      the second turn.
- [ ] AC2: The same case asserts `thread/turns/list` records >= 2 turns and
      `thread/resume` returns the same `threadId`.
- [ ] AC3: No new run script, no new env var, no baked-in default workspace.
- [ ] AC4: `biome check` passes on the edited file and `tsc --noEmit` introduces
      no new errors versus the pre-change tree.

## Out of Scope

- TaskManager / `ProviderTaskRuntime` level Codex integration test.
- Changes to `test:sdk:live` or the Claude live test.
