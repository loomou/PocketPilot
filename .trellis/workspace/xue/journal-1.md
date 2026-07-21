# Journal - xue (Part 1)

> AI development session journal
> Started: 2026-07-15

---

## Workflow Convention

- After each implementation stage has passed its quality checks and been
  committed, merge its feature branch into local `main` before creating the
  next stage's branch from `main`.
- Do not push branches unless explicitly requested.



## Session 1: Complete Windows release validation

**Date**: 2026-07-16
**Task**: Complete Windows release validation
**Branch**: `feat/windows-release-validation`

### Summary

Implemented stopped-only rekey/reset, shared Agent data locking, persistent master-key verification, Windows release documentation, and a packed-install lifecycle smoke test; all project checks and the Windows smoke test passed.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `aff164a` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Environment configuration and mobile API documentation

**Date**: 2026-07-16
**Task**: Environment configuration and mobile API documentation
**Branch**: `feat/environment-config-api-docs`

### Summary

Added allowlisted startup-directory dotenv loading, configurable loopback administration port, generated OpenAPI 3.1 and WebSocket contracts, local-only Swagger UI, packaged documentation assets, release smoke coverage, and backend code specs.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `f4f6fc8` | (see git log) |
| `573b862` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Raw Claude SDK Message Passthrough

**Date**: 2026-07-17
**Task**: Raw Claude SDK Message Passthrough
**Branch**: `feat/claude-sdk-message-passthrough`

### Summary

Added a task-scoped raw SDK WebSocket, separated SDK and control replay, preserved SDK scheduling and approval contracts, removed the normalized instruction protocol, updated OpenAPI/specs, and passed full Windows release validation.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `b4a791b` | (see git log) |
| `5dc7105` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: Claude workspace conversations

**Date**: 2026-07-17
**Task**: Claude workspace conversations
**Branch**: `feature/claude-workspace-conversations`

### Summary

Added authorized-workspace Claude session discovery, bounded history browsing, transparent new/resumed Query activation, SDK-native composer controls, runtime uniqueness migration, OpenAPI contracts, and regression coverage.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `491c846` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: Local workspace authorization management

**Date**: 2026-07-18
**Task**: Local workspace authorization management
**Branch**: `feat/local-workspace-authorization`

### Summary

Added computer-owned native directory authorization, P0-P3 task operation priority, task-scoped SDK socket revocation, safe local APIs, and the authorized-directories UI with full Windows release verification.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `f5c5882` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Claude Code slash command contract

**Date**: 2026-07-18
**Task**: Claude Code slash command contract
**Branch**: `main`

### Summary

Researched the pinned SDK command surface, defined the external mobile Command-panel contract and conversation-reset semantics, confirmed no Agent code change is required, and archived the planning-only task.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

(No commits - planning session)

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: Complete Trellis bootstrap guidelines

**Date**: 2026-07-18
**Task**: Complete Trellis bootstrap guidelines
**Branch**: `main`

### Summary

Audited backend and frontend spec coverage, verified all index links and zero placeholders, marked the bootstrap checklist complete, and archived 00-bootstrap-guidelines.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

(No commits - planning session)

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: Mobile integration guides

**Date**: 2026-07-18
**Task**: Mobile integration guides
**Branch**: `docs/mobile-integration-guide`

### Summary

Added authoritative English and Simplified Chinese mobile integration guides for pairing, session history, raw SDK/control WebSockets, composer controls, approvals, commands, reconnection, and conversation reset; linked both guides from README and corrected the PermissionResult request contract in backend specs.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `6bbf626` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: Real Claude SDK integration tests

**Date**: 2026-07-18
**Task**: Real Claude SDK integration tests
**Branch**: `test/real-claude-sdk-integration`

### Summary

Added an opt-in live Claude SDK test lane with developer-supplied workspace validation, a dedicated runner, two direct turns plus TaskManager resume/history coverage, safe retry diagnostics, documentation, and SDK contract updates. Verified lint, typecheck, default tests, build, sensitive-path scan, and the real SDK command.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `aae3db5` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: Claude Code resume-visible PocketPilot sessions

**Date**: 2026-07-18
**Task**: Claude Code resume-visible PocketPilot sessions
**Branch**: `fix/claude-resume-visible-sessions`

### Summary

Added a truthful PocketPilot Claude Code entrypoint for new Agent SDK conversations only, kept resume Queries unclassified and on the same session ID, added offline environment/resume coverage, and extended the real SDK test to prove terminal /resume parity visibility before and after TaskManager continuation. Updated README, SDK contracts, and Trellis planning artifacts.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `7d3e040` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: Runtime observability logs

**Date**: 2026-07-19
**Task**: Runtime observability logs
**Branch**: `feature/runtime-observability-logs`

### Summary

Added colored foreground diagnostics for runtime, pairing, transports, tasks, and Claude SDK lifecycle; added safe redaction, configurable levels, and distinct development/production endpoint hints.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `7461a25` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: Refresh pairing approval input after QR scan

**Date**: 2026-07-19
**Task**: Refresh pairing approval input after QR scan
**Branch**: `fix/pairing-verification-input-refresh`

### Summary

Added typed pending-pairing polling for the local admin QR flow, preserving staged configuration edits and aborting polling on QR replacement, expiry, or unmount; added regression coverage and frontend specs.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `d02ea37` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 13: Simplify QR pairing approval

**Date**: 2026-07-19
**Task**: Simplify QR pairing approval
**Branch**: `fix/pairing-code-approval-flow`

### Summary

Replaced local-admin pending-pairing polling with an explicit mobile-code approval flow. QR generation now shows a single code input, Approve submits the active pairing ID on click, successful responses update devices locally, failures preserve the QR/code, and frontend specs/tests were synchronized.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `540af86` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 14: Complete provider-extensible Agent API and Claude migration

**Date**: 2026-07-20
**Task**: Complete provider-extensible Agent API and Claude migration
**Branch**: `feat/remote-cli-integration`

### Summary

Migrated Claude behind the provider-extensible Agent API, added provider-aware persistence and native agent routes, removed legacy public Claude routes, updated OpenAPI/mobile/backend specs, and verified lint, typecheck, full tests, build, deterministic OpenAPI generation, and the live Claude SDK test against CLAUDE_SDK_TEST_CWD.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `5e3745c` | (see git log) |
| `8b11a42` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 15: Codex provider runtime parity

**Date**: 2026-07-20
**Task**: Codex provider runtime parity
**Branch**: `main`

### Summary

Aligned Codex App Server with the shared provider task runtime: P2 capacity and generation ordering, P3 reads, native approval ownership and control projection, active-turn replay, reconnect cleanup, API documentation, tests, and live Codex verification.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `1ec6f87` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 16: Codex native action capabilities

**Date**: 2026-07-21
**Task**: Codex native action capabilities
**Branch**: `audit/claude-code-parity`

### Summary

Implemented Codex nativeActions for review/rename/compact, set attachments false, shared turn lifecycle with non-steerable review/compact, updated contracts/docs/tests, and committed the feature.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `effa056` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 17: Codex read-only status catalogs

**Date**: 2026-07-21
**Task**: Codex read-only status catalogs
**Branch**: `audit/claude-code-parity`

### Summary

Implemented Codex P3 status catalogs (account/quota/skills/hooks/MCP), closed statusCatalogs discovery, path-safe projections, reviewed readiness notifications, docs/tests/contracts, and committed the feature.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `af11bb6` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 18: Codex REST thread management

**Date**: 2026-07-21
**Task**: Codex REST thread management
**Branch**: `audit/claude-code-parity`

### Summary

Implemented Codex conversation list filters plus REST fork/archive/unarchive/delete with confirm gates, closed threadManagement, fork task creation, delete-bound-task close, docs/tests/contracts, and committed the feature.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `80a8bda` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 19: Provider readiness and live coverage

**Date**: 2026-07-21
**Task**: Provider readiness and live coverage
**Branch**: `audit/claude-code-parity`

### Summary

Implemented bounded provider readiness probes (30s TTL, single-flight, stable reason codes) for Codex/Claude discovery, expanded opt-in Codex live coverage for status catalogs and disposable fork cleanup, updated contracts/docs/tests, and archived the task.

### Main Changes

- Added `refreshReadiness` with TTL caching and single-flight refresh on discovery/capabilities.
- Codex App Server initialize probe maps install/version/unhealthy statuses without path/secret leakage.
- Claude adapter readiness probe with matching reason-code projection.
- Expanded `pnpm test:codex:live` for status catalogs + disposable thread cleanup.
- Updated agent-provider and codex-app-server contracts for readiness/live harness rules.

### Git Commits

| Hash | Message |
|------|---------|
| `8b21262` | feat(providers): add readiness refresh and expand Codex live coverage |
| `e590a18` | docs(spec): record provider readiness and live harness contracts |
| `785eea1` | chore(task): archive 07-21-provider-readiness-live-coverage |

### Testing

- Unit/route/adapter readiness tests (TTL, single-flight, provisional probe, route refresh).
- Opt-in live suite remains skipped under ordinary `pnpm test`.

### Status

[OK] **Completed**

### Next Steps

- Parent audit `07-20-claude-code-parity-audit` is 4/4 children done; update findings/archive when ready.
- Remaining planning tasks: `07-19-claude-session-id-timing`, `07-19-enable-sdk-streaming`.


## Session 20: Parity audit closeout

**Date**: 2026-07-21
**Task**: Close parent parity audit and leftover 07-19 planning tasks
**Branch**: `audit/claude-code-parity`

### Summary

Updated the parent Claude/Codex parity audit findings to mark children 1–4 done, residual open items (history options, P3 replay checkpoint, deferred attachments), then archived the parent audit plus leftover completed 07-19 research/streaming planning tasks.

### Main Changes

- Marked P1/P2 child tasks done in `07-20-claude-code-parity-audit/prd.md` with residual open map.
- Added completion notes to `07-19-claude-session-id-timing` and `07-19-enable-sdk-streaming`.
- Archived all three planning tasks; task queue is empty.

### Git Commits

| Hash | Message |
|------|---------|
| `74cd7c5` | chore(task): archive 07-19-claude-session-id-timing |
| `12eb51e` | chore(task): archive 07-19-enable-sdk-streaming |
| `9cd4293` | chore(task): archive 07-20-claude-code-parity-audit |

### Testing

- No runtime code changes; archive-only closeout.

### Status

[OK] **Completed**

### Next Steps

- Optional next implementation: P2 history options contracts, or P3 Codex replay checkpoint.
- Attachments remain deferred.


## Session 21: Codex history options contracts

**Date**: 2026-07-21
**Task**: Codex history options contracts
**Branch**: `audit/claude-code-parity`

### Summary

Made the common includeSystemMessages history filter provider-honest: closed historyFilters capability (Claude true / Codex false), reject Codex true with HISTORY_FILTER_NOT_SUPPORTED, keep native Codex rows unchanged, update docs/tests/contracts.

### Main Changes

- Added required closed `historyFilters: { includeSystemMessages: boolean }`.
- Registry sanitizer + null-safe default false closed object.
- Codex readConversation rejects includeSystemMessages=true before native list.
- OpenAPI, mobile guides, and backend contracts updated.

### Git Commits

| Hash | Message |
|------|---------|
| `a4c23b7` | feat(providers): advertise historyFilters and reject Codex includeSystemMessages=true |
| `3ebb04f` | docs(spec): record historyFilters capability and HISTORY_FILTER_NOT_SUPPORTED |
| `5052816` | chore(task): archive 07-21-codex-history-options |

### Testing

- Targeted provider/registry/route/OpenAPI tests passed; typecheck/lint clean.

### Status

[OK] **Completed**

### Next Steps

- Optional: P3 Codex replay checkpoint.
- Attachments remain deferred.


## Session 22: Codex replay checkpoint

**Date**: 2026-07-21
**Task**: Codex replay checkpoint
**Branch**: `audit/claude-code-parity`

### Summary

Exposed a subscribe-time out-of-band agent.checkpoint on the Codex Agent WebSocket so clients can reconnect with a known afterCursor without embedding PocketPilot metadata in native Codex frames. Claude streams unchanged. Docs/contracts/tests updated; task archived.

### Main Changes

- CodexNativeJournal.subscribe emits one agent.checkpoint before retained replay.
- Payload: provider=codex, cursor=latestCursor|null.
- Mobile/OpenAPI docs describe checkpoint exception and reconnect guidance.
- Backend contracts record Codex-only stream purity exception.

### Git Commits

| Hash | Message |
|------|---------|
| `1b22c9a` | feat(codex): emit subscribe-time agent.checkpoint for reconnect cursors |
| `fa3a1ab` | docs(spec): record Codex agent.checkpoint reconnect contract |
| `ed4f025` | chore(task): archive 07-21-codex-replay-checkpoint |

### Testing

- Full suite 190 passed / 4 skipped; typecheck/lint clean.

### Status

[OK] **Completed**

### Next Steps

- Attachments remain deferred.
- Optional follow-up: per-publish checkpoints for long-turn weak-network efficiency.


## Session 23: Polish mobile integration docs

**Date**: 2026-07-21
**Task**: Polish mobile integration docs for parity
**Branch**: `audit/claude-code-parity`

### Summary

Rewrote Codex mobile integration guides (en/zh) and expanded the shared mobile guides for multi-provider parity: closed capabilities, full conversation REST lifecycle, historyFilters honesty, agent.checkpoint reconnect, capability-driven checklist, and error recovery. Light app-server guide cross-link polish only.

### Main Changes

- Full client-path rewrite of Codex mobile guides.
- Multi-provider expansion of general mobile guides (REST inventory + checklist).
- Fixed delete wording terminals → terminates during check.
- Archived docs polish task.

### Git Commits

| Hash | Message |
|------|---------|
| `27c182b` | docs(mobile): rewrite Claude/Codex parity integration guides |
| `2ccb433` | chore(task): archive 07-21-polish-mobile-integration-docs |

### Testing

- `pnpm test -- test/api-docs/mobile-openapi.test.ts` passed during check.
- Keyword/structure parity greps for en/zh guides.

### Status

[OK] **Completed**

### Next Steps

- Optional: open PR for `audit/claude-code-parity`.
- Attachments remain deferred; optional per-publish checkpoint / safety notifications.
