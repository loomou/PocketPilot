# Implementation plan - Real Claude SDK integration tests

## Ordered Checklist

1. Add `live-test-config.ts` with disabled/live union output and safe validation
   for `CLAUDE_SDK_LIVE` plus `CLAUDE_SDK_TEST_CWD`.
2. Add offline unit tests for disabled mode and missing, relative,
   nonexistent, file, and valid-directory live values.
3. Replace the current single wrapper-only live test with one serial scenario:
   - direct production wrapper for two turns;
   - bounded init/result/model assertions and guaranteed cleanup;
   - public catalog visibility for the observed session;
   - real TaskManager attach/resume for one third turn;
   - composer control ordering, append-only input, state/raw-event/history, and
     interrupt assertions;
   - guaranteed manager/database cleanup.
4. Add the Node ESM live-test runner and `test:sdk:live` package script.
5. Document prerequisites, placeholder environment configuration, command,
   expected three turns, persistent marked session, and default-suite skip in
   README Development.
6. Run offline config tests and the complete default quality gate.
7. Scan tracked changes for the local development path, credentials, settings
   content, and raw model output.
8. Set `CLAUDE_SDK_TEST_CWD` only in the current process invocation and run
   `pnpm test:sdk:live` against the requested local workspace.
9. Inspect the live failure/success behavior, fix reliability issues, and rerun
   both offline and live gates until green.

## Validation Commands

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
$env:CLAUDE_SDK_TEST_CWD = "<absolute-workspace-path>"
pnpm test:sdk:live
Remove-Item Env:CLAUDE_SDK_TEST_CWD
```

Also run a content scan proving the real local workspace path and local Claude
settings never entered tracked files.

## Risk and Rollback Points

- **Real model cost/time:** one full run is limited to approximately three
  turns in one session; do not split the same assertions across more Queries.
- **Hanging subprocess:** all SDK waits use internal deadlines and all resource
  owners have `finally` cleanup before the outer Vitest timeout.
- **Workspace mutation:** prompts forbid tools, permission mode is `plan`, and
  the test itself performs no workspace writes.
- **Catalog delay:** use a bounded retry around public session visibility, not
  fixed sleep or direct `.claude` parsing.
- **Environment leakage:** the runner forwards the configured path only to the
  child process; README uses a placeholder and tests never log the value.
- **Default-suite regression:** first validate that no environment values means
  the live suite remains skipped.

Rollback is documentation/test-only and removes all listed deliverables as one
unit. Do not change production SDK code merely to make the live test pass until
the mismatch has been proven to be a production defect and separately
reviewed.

## Review Gate Before Start

- Confirm the PRD contains no unresolved product decisions.
- Confirm the scenario uses one session and approximately three real turns.
- Confirm no tool approval or workspace mutation is allowed.
- Confirm the dedicated runner requires only the developer-supplied workspace
  value and ordinary `pnpm test` stays offline.
- Obtain explicit implementation approval before `task.py start`.
