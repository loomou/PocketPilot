# Implement provider readiness and live coverage

## Goal

Make provider readiness trustworthy and verifiable: mobile clients can discover bounded, non-secret readiness state for Claude and Codex, and optional live suites cover the newly landed provider REST/WebSocket surfaces without destructive host side effects.

## Background

- Parent audit: `.trellis/tasks/07-20-claude-code-parity-audit`
- Completed children in this parity sequence:
  - native actions
  - read-only status catalogs
  - thread management
- Provider status enum already exists:
  `available | not_installed | disabled | unhealthy | unsupported_version`
- Current readiness is minimal:
  - Codex: startup command-path check only
    (`isCodexCommandAvailable` → `not_installed` / `CODEX_COMMAND_NOT_FOUND`)
  - Claude: hardcodes `available`
  - No version probe, no unhealthy transitions, no refresh path after startup
- Existing live suites:
  - `pnpm test:codex:live` → bridge-level App Server smoke
    (init, model/collaboration/permission catalogs, turn stream, history,
    interrupt). Does **not** exercise provider REST/Agent WS adapter surface
    for actions, status catalogs, or thread management.
  - `pnpm test:sdk:live` → Claude SDK/TaskManager smoke.
- Ordinary `pnpm test` must keep skipping live suites unless the caller provides
  workspace/config.

## Confirmed facts

- Capability discovery already advertises closed
  `nativeActions` / `statusCatalogs` / `threadManagement`.
- Registry already returns unavailable providers with safe descriptors and
  rejects execution with `AGENT_PROVIDER_UNAVAILABLE`.
- Contracts forbid returning executable/config paths, credentials, or raw
  process errors in descriptors.
- Codex bridge initialize already enforces `isSupportedCodexVersion` and can
  throw `CODEX_APP_SERVER_VERSION_UNSUPPORTED`.
- Registry `descriptors()` / `descriptor()` are currently synchronous and read
  a static adapter descriptor snapshot.
- Live tests must use caller-provided absolute workspaces; never hardcode
  developer machine paths.

## Decisions

- **D1 readiness depth (2026-07-21):** Install presence + bounded
  version/protocol support detection with cached initialize results.
  - Keep/improve command-exists checks.
  - Add timeboxed version/protocol probing for Codex (and Claude if cheap).
  - Map `not_installed` / `unsupported_version` / `available` /
    probe-failure `unhealthy` with stable reason codes.
  - Cache results with refresh on provider discovery/capabilities reads and a
    short TTL.
  - No continuous health daemon and no periodic background spawn loop.
- **D2 live suite scope (2026-07-21):** Safe core + non-destructive extras.
  - Keep existing turn/history/interrupt smoke.
  - Add provider-level readiness discovery.
  - Add status catalogs (account/rateLimits/skills/hooks/MCP).
  - Add rename and list filters.
  - Mutating extras only with cleanup: fork then archive/delete the forked
    thread; never mutate arbitrary user threads.
  - Exclude detached review, login/write, MCP tool execution, and inline review
    in this batch.

## Requirements

### R1 — Bounded readiness state
- Publish provider readiness using the existing closed status enum.
- Reason codes remain stable and non-secret.
- Never leak absolute install paths, env dumps, raw stderr, credentials, or
  email.

### R2 — Probe boundaries
- Check install presence and version/protocol support.
- Probes are timeboxed and cacheable.
- Refresh on `GET /v1/providers` and `GET /v1/providers/{id}/capabilities` when
  the cache is stale, and allow adapter-local reuse of a recent successful probe.
- Do not launch unbounded concurrent probes for the same provider.

### R3 — Live coverage for landed surfaces
- Expand optional Codex live coverage for D2 scenarios with cleanup for any
  mutable artifacts.
- Keep live suites opt-in and skipped by default.
- Ordinary `pnpm test` remains free of live dependencies.

### R4 — Docs and contracts
- Document readiness semantics, reason codes, cache/TTL behavior, and live
  harness usage.
- Keep unit/integration coverage for readiness transitions without requiring
  live credentials in CI.

## Acceptance Criteria

- [ ] AC1: Provider discovery exposes bounded readiness statuses/reason codes
      for missing, unsupported, unhealthy, and available cases without secret
      leakage.
- [ ] AC2: Readiness probing is timeboxed/cached, serializes per provider, and
      does not block ordinary non-discovery requests with unbounded process
      launches.
- [ ] AC3: Optional live suites cover readiness discovery, status catalogs,
      rename, list filters, and fork+cleanup mutations; existing turn/history
      smoke remains.
- [ ] AC4: Ordinary `pnpm test` remains free of live dependencies.
- [ ] AC5: Docs, focused tests, and contracts describe readiness semantics and
      live harness usage.

## Out of scope

- Implementing deferred attachments
- Account login/logout or credential storage redesign
- Full Claude/Codex feature parity beyond readiness/live verification
- Replay checkpoint optimization
- Continuous background process supervision / auto-heal restarts
- Deep periodic unhealthy runtime spawn loops
- Live inline review coverage in this batch

## Technical Notes

- Prefer a provider-neutral readiness refresh hook on adapters rather than
  hardcoding `providerId === "codex"` in routes.
- Codex can reuse existing command availability helpers and supported-version
  checks; a probe should not leave orphan App Server children.
- Claude readiness should be cheap: package/protocol support rather than
  launching a full agent session.
- Live mutating cases must create disposable threads and clean them up even on
  failure paths.
