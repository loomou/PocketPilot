# Technical Design — PocketPilot

## Architecture

The Windows 11 Agent is a manually started Node.js process with two independent Fastify listeners that share one core runtime and SQLite database:

```text
Mobile app -- user-operated connection --> Remote API (HTTP + WebSocket)
                                              |
                                              v
                                     Auth / Task Manager / SDK Adapter
                                              |
                         +--------------------+--------------------+
                         v                                         v
               Claude Agent SDK sessions                 SQLite + AES-256-GCM

Local browser --> Local Admin (127.0.0.1 only) -----------^
```

- `remote-api` listens on the configured address and port, defaulting to `127.0.0.1`. It serves only versioned mobile HTTP and WebSocket control APIs.
- `local-admin` is a separate Fastify instance bound only to `127.0.0.1`. It hosts the configuration page and its local APIs; mounting it on the remote listener is forbidden.
- The Agent does not configure, operate, detect, or validate ngrok, Tailscale, TLS, or other connectivity. The local administrator manually supplies the mobile-reachable base URL used in pairing QR codes.
- The process is started with `agent start` and stopped by `Ctrl+C` or `agent stop`. Both stop paths invoke one coordinated shutdown sequence.

## Technical Stack Selection

### Confirmed

| Concern | Selection |
|---|---|
| Language/runtime | TypeScript on Node.js 24 LTS |
| Claude execution | TypeScript Claude Agent SDK |
| Remote and local HTTP | Fastify + `@fastify/websocket` |
| Database | SQLite through `better-sqlite3` |
| Schema/migrations | Drizzle ORM + Drizzle Kit |
| At-rest encryption | Node `crypto`: HKDF-SHA-256 plus AES-256-GCM |

### Recommended for review

| Concern | Recommendation | Why |
|---|---|---|
| API validation/types | Zod + Fastify Zod Type Provider | Shared runtime validation and inferred TypeScript types for HTTP and WebSocket message contracts. |
| Device proof | Ed25519 device key pairs using Node Web Crypto | Small signatures and explicit proof-of-possession without introducing a JWT signing dependency. |
| Credentials | Opaque random access/refresh credentials stored as encrypted/verifier-backed server state | Immediate revocation and refresh-reuse detection are straightforward. |
| HTTP/WS protocol | REST under `/v1` plus a JSON WebSocket event protocol | Standard HTTP/WS, no Socket.IO transport semantics. |
| CLI/config | `commander` plus environment-only master key; non-secret settings in SQLite | Small, explicit manual operations. |
| Local admin UI | React + Vite + shadcn/ui, built to static assets and served by `@fastify/static` | Familiar component system; page is intentionally implemented last. |
| QR rendering | `qrcode` generating SVG for the local page | No external service or image runtime. |
| Testing | Vitest, Fastify `inject`, SDK contract tests, and Playwright only for the local admin page | Fast feedback for TypeScript plus browser coverage where it matters. |
| Lint/format | Biome plus `tsc --noEmit` | One fast formatter/linter, with TypeScript as the type authority. |
| Commit quality gates | Husky + lint-staged + commitlint with Conventional Commits | Fast staged-file checks before commit and consistent commit messages without running the full suite on every edit. |
| Structured logging | Fastify/Pino with mandatory redaction | Native Fastify integration and safe JSON logs. |
| Packaging | `pnpm` workspace, `tsup` Node build, first release installed with Node 24 rather than a single executable | Avoids early native-addon executable-packaging complexity; validate `better-sqlite3` prebuilds per platform later. |
| In-process coordination | Small internal per-task async mutex/serial executor, no Redis/queue | One local Agent process and a three-task default make an external coordinator unnecessary. |

These recommendations do not alter the product constraints; revise this table before task activation if any choice is changed.

## Claude Agent SDK Integration

Pin and validate a TypeScript Claude Agent SDK version before release. The currently researched 0.3.210 API supports the required model:

- A task owns a long-lived `Query` created with one task-scoped `AsyncIterable<SDKUserMessage>`. The SDK consumes that iterable through `Query.streamInput()` and closes CLI stdin when the iterable ends, so every later instruction is appended to the same still-open input stream; the Agent must not call `streamInput()` once per turn.
- The SDK emits a `session_id` on its messages rather than exposing it on `Query` or `initializationResult()`. The task event loop captures the initial system event's ID for persistence; `Options.resume` restores the conversation context after an unexpected Agent restart.
- The initial system event can be preceded by SDK hook events and does not arrive until the first streamed user instruction, so task creation does not persist a session ID before its first turn.
- `Query.interrupt()` powers user interruption; the Agent waits for its state transition before accepting another instruction.
- `Query.supportedModels()` provides the mobile model catalog. The Agent owns no model catalog.
- `Query.setPermissionMode()` and `Query.setModel()` are forwarded according to the product rules: permission mode follows SDK acceptance; model changes only occur while the task is idle.
- `canUseTool` emits a mobile approval event and waits on a task-scoped deferred decision. SDK abort signals, interruption, close, and shutdown reject that deferred decision. A stale response is rejected by its approval ID.

The Agent never parses Claude configuration files, manages Claude credentials, or stores Claude conversation history. SDK configuration precedence and local credential resolution remain authoritative.

### Task lifecycle

```text
new -> idle -> executing -> awaiting_approval -> executing -> idle
          |         |               |
          |         +-- interrupt --+
          |                         |
          +-- close ----------------+--> terminal

unexpected restart: executing/awaiting_approval -> interrupted
interrupted -- explicit resume --> idle
manual Agent termination: every non-terminal task -> terminal
```

- `idle` sessions remain reusable and do not consume concurrency.
- Only `executing` and `awaiting_approval` tasks count against the configured concurrency limit (default 3).
- A close request has highest priority: it cancels current SDK work and any pending approval before making the task terminal.
- An unexpected restart never retries a half-finished instruction. Explicit resume only reconnects the SDK session and returns the task to `idle`.

## Remote API Contract

All remote paths are versioned under `/v1`; a future incompatible protocol receives a new prefix. JSON response errors use `{ code, message, details? }`. Every mobile state-changing operation carries a UUID `operationId`.

| Surface | Purpose |
|---|---|
| `GET /v1/capabilities` | SDK version, supported permission modes, models, and protocol metadata. |
| `POST /v1/pair/*` | QR pairing initiation, device-key registration, and approved credential delivery. |
| `POST /v1/auth/refresh` | Device proof plus rotating refresh credential exchange. |
| `GET /v1/tasks`, `POST /v1/tasks` | List sessions and create a task after workspace-risk acknowledgement. |
| `GET /v1/tasks/:id` | Task state and metadata only; never a reconstructed transcript. |
| `POST /v1/tasks/:id/{instruction,interrupt,close,resume}` | Turn and lifecycle operations. |
| `POST /v1/tasks/:id/{model,permission-mode}` | Model and SDK-governed permission-mode changes. |
| `POST /v1/tasks/:id/approvals/:approvalId` | Resolve an outstanding approval. |
| `GET /v1/events` (WebSocket) | Authenticated connection; clients subscribe with `{ taskId, afterCursor }`. |

HTTP handles request/response control. WebSocket delivers normalized events and subscription acknowledgements. Each task has a monotonic cursor. A subscription first replays retained events after `afterCursor`, then switches to live delivery. If a replay cap was reached, the Agent reports `EVENT_REPLAY_STORAGE_LIMIT_REACHED` rather than fabricating missing history.

Required errors include `UNSUPPORTED_PERMISSION_MODE`, `TASK_BUSY`, `CONCURRENT_TASK_LIMIT_REACHED`, `WORKSPACE_SCOPE_RISK_NOT_ACCEPTED`, `EVENT_REPLAY_STORAGE_LIMIT_REACHED`, and stale-approval rejection. A repeated `(deviceId, operationId)` returns the original operation result for 24 hours.

## Authentication and Pairing

Use opaque credentials and device public keys rather than bearer JWTs so revocation is checked server-side on every HTTP request and WebSocket connection.

1. The local administrator generates a QR containing only the configured base URL, Agent identity/fingerprint, a random one-time pairing ID, and expiry metadata. It contains no access or refresh credential.
2. The mobile app generates a device signing key pair and submits its public key plus a display name for that pairing ID.
3. Local Admin shows the device name and a six-digit verification code. On matching approval, the Agent creates a device session and returns a rotating refresh credential for that device.
4. Refresh exchanges require a fresh signed server challenge from the registered device key. The refresh credential is atomically replaced; a reused predecessor revokes that device session.
5. Access credentials expire after one hour. Refresh credentials expire after 30 days of device inactivity. Device revocation or refresh reuse invalidates access credentials immediately and closes that device's WebSockets.

The pairing record is single-use and expires after five minutes. All paired devices are equal-owner devices; task operations are serialized per task and audit the initiating device.

## Persistence and Encryption

The supported runtime is Node.js 24 LTS. SQLite access uses `better-sqlite3` with Drizzle ORM and Drizzle Kit for schema/migrations; direct `better-sqlite3` transactions remain available for cryptographic and event-journal operations. Native-module packaging must be validated for Windows 11 now and future cross-platform releases without changing this persistence contract. SQLite contains:

- Agent settings: listener, mobile base URL, workspace roots, concurrency.
- Device/session state, refresh-token lineage, access-token state, pairing records, and 24-hour idempotency records.
- Task metadata and SDK session IDs, never Claude transcript history.
- Security/control audit metadata for 30 days.
- Encrypted current-turn event-overflow rows only; these are deleted at turn cleanup and Agent startup.

`AGENT_MASTER_KEY` is a user-supplied 32-byte environment value. Derive scoped encryption keys from it; each protected value uses AES-256-GCM with a random nonce and associated data containing its table/key/version. Store versioned ciphertext envelopes. Refresh secrets are represented by secure verifiers; plaintext tokens are never persisted.

`agent rekey` runs only when the Agent is stopped. It verifies the old key, re-encrypts protected fields atomically under a new key, and commits only after all records succeed. With a lost old key, an explicitly confirmed reset drops Agent-managed database data; it does not delete Claude credentials or Claude session files.

## Event Replay

Each executing turn writes ordered normalized events to a small in-memory buffer. After a small implementation-defined threshold, events overflow to AES-256-GCM-encrypted SQLite rows. The combined replay budget is 256 MiB per executing task. At the limit, the task continues and live subscribers continue receiving events, but replay retention stops and an event announces the condition.

The buffer is deleted on `idle`, `terminal`, and Agent startup. It is a transport-recovery mechanism only, not SDK history or restart recovery.

## Local Administration

The `localhost` page provides Agent status, mobile base URL, QR pairing approval, devices/revocation, workspace roots, concurrency, listener settings, audit viewing, and rekey/reset guidance. State-changing local actions require same-origin CSRF protection; the local listener never shares routes with the remote API.

It has no task dashboard/control, no Claude API-key entry, and no Claude configuration editor. Listener changes apply on the next manual Agent start. The page never starts or stops the Agent.

## Safety Boundaries and Operations

- Workspace roots restrict task initial `cwd` selection only. They are not a filesystem sandbox, particularly when users choose permissive Claude modes. The mobile client must explicitly acknowledge this per task or task creation fails.
- Multiple tasks may share a workspace. The Agent does not implement locks or Git conflict scheduling.
- Mobile disconnection does not pause a task. A pending approval waits indefinitely; an executing turn keeps running and may replay events while it remains active.
- Manual Agent termination cancels every runtime and pending approval, makes every non-terminal task non-resumable, and must leave no Claude work running in the background.
- The first release deliberately has no Agent-managed TLS. Users must choose an encrypted connection path when exposing HTTP beyond a trusted local path.

## Validation and Rollout

- Start with Windows 11 and Node.js 24 LTS only.
- Release a CLI-distributed Agent with an explicit environment-key setup guide; do not register a service or login startup task.
- Add SDK contract tests against the pinned SDK/Claude CLI combination for capability discovery, streaming input, session resume, interruption, approvals, models, and permission modes.
- Upgrade the SDK only through a compatibility test matrix. Roll back by stopping the Agent and restoring a compatible packaged build; encrypted Agent data remains usable with the same master key.
