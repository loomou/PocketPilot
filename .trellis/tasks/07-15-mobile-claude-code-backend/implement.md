# Implementation Plan — PocketPilot

## Preconditions

- Obtain user review of `prd.md`, `design.md`, and this plan before running `task.py start`.
- Pin Node.js 24 LTS and the validated Claude Agent SDK version.
- Do not begin the configuration page until core remote API, task runtime, recovery, and concurrency behavior pass their tests.
- User-approved exception: create the standalone React/Vite/shadcn local-admin
  frontend scaffold early. It contains no Agent API client, no configuration
  mutation, no task controls, and no server listener; the functional page stays
  in item 9 after the required core behavior passes.
- User-approved exception: execute item 5 as an isolated Claude Agent SDK
  adapter spike before items 2–4. It validates the pinned SDK's process,
  session, interruption, approval, model, and permission behavior without
  adding persistence, authentication, or mobile/remote API implementation.

## Ordered Work

1. **Bootstrap the TypeScript Agent package**
   - Create strict TypeScript, Node.js 24 LTS, Fastify, `@fastify/websocket`, Zod/Fastify Zod Type Provider, test, lint, and formatting configuration.
   - Configure Husky, lint-staged, and commitlint with Conventional Commits: staged files run Biome checks in `pre-commit`; commit messages run through `commit-msg`. Keep full type-check and tests in the quality/CI gate rather than every local commit.
   - Add the CLI surface: `agent start`, `agent stop`, `agent rekey`, and explicit reset flow.
   - Validate packaging and manual foreground startup on Windows 11.

2. **Build persistence, crypto, and settings primitives**
   - Implement Drizzle schema/migrations on `better-sqlite3` for settings, devices, credentials, pairings, tasks, operation results, audits, and temporary event rows.
   - Implement AES-256-GCM envelopes, scoped key derivation, master-key validation, rekey transaction, and reset safeguards.
   - Add retention jobs for audit and idempotency records, plus startup deletion of temporary event rows.

3. **Implement local process and listener boundaries**
   - Start separate remote and localhost-only Fastify instances sharing core services.
   - Implement listener/base-URL settings, manual-start application of listener changes, health/status behavior, and coordinated shutdown.
   - Add local-admin same-origin/CSRF protections before mutating configuration APIs.

4. **Implement pairing and device authentication**
   - Generate QR payloads, one-time pairing records, verification codes, local approval, device-key challenges, refresh rotation, reuse detection, access credential checks, and immediate revocation.
   - Track WebSockets by device and close them on revocation.
   - Test expiry, duplicate pairing, replayed refresh, stale challenge, and multi-device behavior.

5. **Create the Claude SDK adapter spike and contract tests**
   - Exercise a long-lived streaming input, `supportedModels`, permission modes, `canUseTool`, interruption, and `Options.resume` with the pinned SDK. `Query.streamInput()` owns the one input stream and closes CLI stdin once that iterable ends; later turns are appended to the same open iterable rather than sent through repeated `streamInput()` calls.
   - Capture the exact normalised event mapping and feature/version capability checks.
   - Fail early if the installed Claude CLI/SDK combination cannot satisfy a required contract.

## SDK Spike Record (2026-07-15)

- Pinned `@anthropic-ai/claude-agent-sdk@0.3.210` passed the opt-in live
  contract test on Node.js 24.14.0: initialization/model discovery, two
  consecutive instructions on one long-lived input stream, permission-mode
  forwarding, model forwarding after the first turn, and interruption control.
- The local `claude --version` reports Claude Code 2.1.190. The SDK's own
  process launch was used for the live contract; the Agent does not inject
  credentials or parse Claude configuration.
- `initializationResult()` has no session ID. The adapter captures
  `SDKMessage.session_id` while consuming events, and the contract test accepts
  SDK hook events that can precede the `system:init` message.
- Unit contracts cover typed input construction, event normalization, session
  resume-option forwarding, and `canUseTool` approval resolution and abort
  cancellation. A later task runtime must register each pending approval so it
  can cancel it during interrupt, close, and shutdown.

## Persistence Foundation Record (2026-07-16)

- Added `better-sqlite3`, Drizzle ORM, Drizzle Kit, and the initial generated
  SQLite migration covering settings, devices, credentials, pairings, tasks,
  idempotency records, audits, and encrypted event overflow.
- Storage uses WAL with foreign keys enabled. Drizzle owns schemas/migrations;
  targeted `better-sqlite3` transactions own rekeying, retention, reset, and
  temporary-event cleanup.
- `AGENT_MASTER_KEY` is a required 32-byte unpadded base64url value at secure
  runtime startup. AES-256-GCM envelopes derive per-record keys through HKDF
  and bind table, column, record ID, and version as authenticated data.
- The persistence primitive intentionally sets no listener or product defaults;
  the future process/listener layer will validate and persist those settings.
- `rekeySensitiveData` and `resetAgentData` are storage primitives only. The
  future process/CLI layer must enforce the Agent-stopped precondition before
  exposing them to a user.

## Process and Listener Boundaries Record (2026-07-16)

- `agent start` now validates `AGENT_MASTER_KEY`, migrates/prunes Agent-owned
  storage, starts separate remote and local-admin Fastify instances, and stays
  foreground-controlled by the user. The remote listener exposes only
  `/healthz` until device authentication and the versioned control API exist.
- Remote listener settings are stored as Zod-validated `runtime` settings and
  are read only during manual startup: default `127.0.0.1:43182`, with an
  optional user-entered mobile base URL. The local-admin listener is always
  `127.0.0.1` and defaults to port `43183`.
- `GET /admin/status` and `GET /admin/csrf` exist only on the local listener.
  Unsafe future local-admin mutations require exact loopback origin plus a
  per-runtime CSRF token; the remote application has no local-admin routes.
- `agent stop`, Ctrl+C, and `SIGTERM` share `AgentRuntime.shutdown()`. The
  stop command uses a temporary, random, loopback-only control credential; no
  browser page receives it. Ownership-matched cleanup prevents a failed second
  startup from deleting another Agent's control-state file.
- Unit/integration tests cover listener isolation, CSRF/control-token guards,
  manual-start settings, control-state ownership, and external stop shutdown.

6. **Implement task runtime and state machine**
   - Build per-task serialized control lanes and independent SDK lifecycles.
   - Enforce capacity only for executing/awaiting-approval tasks; enforce start-directory allowlist and per-task risk acknowledgement.
   - Implement idle persistence, interrupt, high-priority close, approval waiting/cancellation, model changes, SDK-governed permission changes, and task recovery.
   - Add operation-id deduplication and audit emission for every state-changing mobile action.

7. **Implement WebSocket event delivery and replay**
   - Add authenticated subscribe/replay/live handoff with monotonic cursors.
   - Add memory buffer, encrypted SQLite overflow, 256 MiB cap event, cleanup, and no-replay-after-idle behavior.
   - Test switching tasks, disconnect/reconnect during execution, cap behavior, and task-failure isolation.

8. **Implement versioned mobile HTTP API**
   - Add capabilities, task, approval, auth, pairing, lifecycle, and WebSocket contracts under `/v1`.
   - Validate schemas at every boundary and make errors stable for mobile integration.
   - Add end-to-end tests for pairing through task completion and restart states.

9. **Implement the localhost configuration page last**
   - Add a React + Vite + shadcn/ui local page with status, base URL, QR pairing approval, devices/revocation, workspace roots, concurrency, listener settings, audits, and rekey/reset guidance.
   - Confirm no route can be reached through the remote listener and no page action starts/stops the Agent or controls tasks.

10. **Package and validate the first Windows release**
    - Test manual installation, environment-key setup, listener configuration, ngrok-style loopback forwarding, and Tailscale-compatible non-loopback binding.
    - Publish a connectivity responsibility guide that documents the HTTP/no-TLS boundary and manual URL field.

## Required Validation

- Unit tests for crypto envelopes, token rotation/reuse, expiry, idempotency, state transitions, and workspace-risk acknowledgement.
- SDK integration tests for long-lived input, interrupt, approval cancellation, model/mode controls, session resume, and capability discovery.
- HTTP/WebSocket integration tests for authentication, revocation, replay ordering, reconnect, concurrent task isolation, and 256 MiB replay limit.
- Browser/local-admin tests for loopback-only exposure and CSRF protection.
- Windows 11 smoke test for CLI start/stop/rekey/reset and manual connectivity setup.
- Lint, type-check, full test suite, and a security review of secret/log handling before release.
- Verify the commit hooks reject an invalid Conventional Commit message and a staged file that fails Biome checks.

## Risk and Rollback Points

| Risk | Mitigation / rollback |
|---|---|
| SDK behavior diverges from the researched contract | Pin versions, run adapter contract tests before enabling task APIs, and roll back the packaged SDK integration. |
| Crypto migration/rekey failure | Use transaction-backed migration with a verified backup; never overwrite the old database before commit. |
| Event replay fills disk | Enforce the per-task 256 MiB cap; task continues with live events. |
| User exposes plain HTTP on an unsafe network | Document responsibility at setup and show the connection warning; Agent does not falsely claim TLS protection. |
| Remote route exposes local admin | Keep it in a separate loopback-only listener and test the negative remote-route case. |
| Manual stop leaves child work running | Make SDK cancellation and child-process exit verification a shutdown test gate. |

## Files Likely to Be Added

- CLI/bootstrap and package configuration.
- `src/core/` for task lifecycle, event journal, SDK adapter, and errors.
- `src/auth/` for pairing, device proof, credential rotation, and revocation.
- `src/storage/` for migrations, repositories, crypto, and rekey/reset.
- `src/remote-api/` and `src/local-admin/` for the two Fastify listeners.
- `test/` for unit, integration, SDK contract, and Windows smoke coverage.
