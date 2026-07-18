# Implementation plan - Claude Code resume-visible PocketPilot sessions

## Ordered Checklist

1. Update `src/claude-sdk/session.ts` so new-conversation Queries receive a
   copied child environment with `CLAUDE_CODE_ENTRYPOINT=pocketpilot`.
2. Keep resume Queries unchanged except for the existing `Options.resume`; do
   not pass the PocketPilot entrypoint override, fork, or alter session IDs.
3. Extend `test/claude-sdk/session.test.ts` for new/resume Query option
   construction, environment inheritance, input immutability, and unchanged
   existing behavior.
4. Extend `test/claude-sdk/live-contract.test.ts` to assert the new session ID
   appears under `listSessions({ includeProgrammatic:false })` before and after
   TaskManager resumes it.
5. Update README live-test wording to state that terminal `/resume` parity is
   verified and that legacy `sdk-ts` sessions are not migrated.
6. Update `.trellis/spec/backend/claude-sdk-contracts.md` with the
   new-conversation entrypoint rule, resume non-reclassification rule, upgrade
   gate, and required tests.
7. Run the full offline quality gate and sensitive-data scan.
8. Run `pnpm test:sdk:live` with a process-only developer workspace value and
   confirm one session remains visible under terminal-parity filtering after
   resume/history checks.

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

Also scan all changed source, tests, documentation, specs, and task files for
the concrete developer path, raw model output, credentials, and Claude settings
content.

## Review Gates

- Confirm the entrypoint value is exactly `pocketpilot`, never `cli`.
- Confirm only Queries without `resume` receive the override.
- Confirm `process.env` is copied, not mutated or replaced with an incomplete
  allowlist.
- Confirm live visibility uses `includeProgrammatic:false`, the pinned SDK's
  documented terminal `/resume` parity filter.
- Confirm no code reads or writes Claude private session storage.
- Confirm legacy `sdk-ts` sessions remain supported by PocketPilot without a
  migration claim.

## Risks and Rollback Points

- The environment variable is not a documented SDK option. Keep the change
  isolated in `session.ts`, pin the SDK, and treat the live filter assertion as
  an upgrade gate.
- An incorrect resume override could reclassify or hide existing sessions.
  Offline option-forwarding tests are required before any live run.
- An explicit `Options.env` replaces SDK default inheritance input. Copy the
  complete current process environment before adding the entrypoint.
- If the live terminal-parity assertion fails, do not fall back to `cli`, PTY
  automation, or transcript edits. Roll back to planning and reassess upstream
  support.
