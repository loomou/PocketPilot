# Implementation Plan — Claude Session History Browsing

## Preconditions

- The public UX is Claude-session-centric; PocketPilot tasks remain opaque
  internal runtime handles.
- Every authorized workspace offers New conversation as well as historical
  session selection.
- Session discovery/history use only installed SDK APIs and never parse Claude
  files directly.
- Slash Commands, Skills, Agents, MCP status, context/background-task status,
  account data, and ultracode/workflow controls are deferred to later tasks.
- Historical `SessionMessage` and live `SDKMessage` values remain SDK-owned and
  are never normalized into a PocketPilot transcript.
- A selector change immediately calls the corresponding live SDK control. The
  accepted value applies on the next turn; Send carries only a raw
  `SDKUserMessage`.
- Worktree enumeration is disabled for the authorized-workspace boundary.
- No implementation begins until the user reviews the planning artifacts and
  `task.py start` has run on a new non-`codex` feature branch from `main`.

## Ordered Work

1. **Lock installed SDK contracts in tests**
   - Add type/fixture coverage for `SDKSessionInfo`, `SessionMessage`,
     `ListSessionsOptions`, `ModelInfo.supportedEffortLevels`, `EffortLevel`,
     `Query.applyFlagSettings()`, and `resolveSettings()`.
   - Extend the opt-in live contract to change model, permission mode, and
     effort between turns on one Query without restarting it.
   - Cover the documented `max` declaration/runtime boundary in one narrow SDK
     adapter test; never use `setMaxThinkingTokens()`.

2. **Add the Claude session catalog adapter**
   - Create an injectable adapter over `listSessions`, `getSessionInfo`,
     `getSessionMessages`, and `resolveSettings`.
   - Preserve returned SDK objects and unknown fields; do not reconstruct
     session or history rows.
   - Unit-test SDK option forwarding, chronological message return, empty
     results, failure mapping, and no direct filesystem reads.

3. **Evolve task metadata for discovered-session runtimes**
   - Add task origin (`pocketpilot` / `claude-session`) and make stored
     permission mode nullable for SDK-owned control defaults.
   - Add a partial unique index for non-terminal non-null SDK session IDs.
   - In migration, terminalize older duplicate owners except the most recently
     updated task before creating the index.
   - Update Drizzle schema, repository parsing, operation-result schemas, task
     action union (`attached`, `effort-changed`), fixtures, and migration
     snapshots.
   - Verify existing task rows and cached operation results remain readable.

4. **Centralize workspace/session authorization**
   - Reuse the task manager's canonical workspace authorization for catalog,
     history, and attachment.
   - List with `includeWorktrees: false` and `includeProgrammatic: true`.
   - Check present session `cwd` values without modifying the SDK objects.
   - For a single-session read whose `cwd` is absent, confirm membership through
     worktree-disabled SDK enumeration before allowing history/attachment.
   - Add traversal, symlink, removed-root, missing-cwd, out-of-root cwd,
     worktree, and page-filtering tests.

5. **Implement session list and history manager operations**
   - For the session catalog, add SDK `limit`/`offset` passthrough and calculate
     `nextOffset` from SDK rows consumed.
   - Validate a selected session with `getSessionInfo` before reading messages.
   - For history, call the supported SDK reader, preserve original
     `SessionMessage` values, and slice a stateless latest/older page of at most
     50 messages after the SDK reconstructs its chronological chain.
   - Implement optional `beforeUuid`, `hasMoreBefore`, and the next earliest
     UUID as out-of-band page metadata. Return `HISTORY_CURSOR_STALE` when the
     anchor no longer exists; never alter an SDK message.
   - Forward `includeSystemMessages` explicitly and require one cursor sequence
     to retain the same filtering mode.
   - Serialize reads per `(workspace, sessionId)` on a lane independent from
     runtime controls, retain no full history cache, and map SDK read/parse
     failure to retryable `CLAUDE_HISTORY_UNAVAILABLE`.
   - Ensure no catalog/history value reaches SQLite, operation results, audits,
     or logs.
   - Test empty/short/exact-page/multi-page histories, page ordering, stale
     anchors, duplicate scroll requests, system-message filtering, SDK failure,
     and continued Query use while history is slow or unavailable.

6. **Implement new-conversation creation, transparent attachment, and uniqueness**
   - Add an idempotent session-centric new-conversation operation that creates
     an idle `claude-session` runtime with authorized cwd, no resume ID, and no
     PocketPilot control override.
   - Add the idempotent session-attachment operation with workspace-risk
     acceptance and metadata-only results.
   - Under one attachment/capacity lane, reuse a matching non-terminal task or
     create a `claude-session` task with the SDK session ID already stored.
   - Transparently make a recovered interrupted attachment idle without
     resubmitting any prompt.
   - Return a stable conflict if uniqueness cannot be established; start no
     second Query.
   - Prove attachment itself consumes no active-turn capacity.

7. **Activate new/resumed Queries when the raw socket attaches**
   - Extend the task SDK route to subscribe to raw output before activating a
     discovered-session runtime.
   - For `claude-session` tasks, open with cwd and no PocketPilot
     model/permission/effort override; include `resume` only when the runtime
     already owns a selected SDK session ID.
   - Persist the raw `system/init.session_id` for a new conversation without
     wrapping or removing it from the SDK stream.
   - Preserve existing lazy behavior for explicitly created PocketPilot tasks.
   - Test that the first server frame sequence includes the original raw
     `system/init`, with no wrapper, and that multiple sockets reuse one Query.
   - Keep reconnect, revocation, close codes, and active-turn replay behavior.

8. **Expose SDK-owned composer options**
   - Extend `ClaudeSdkSession` readiness to make `supportedModels()` available
     after the event consumer is installed.
   - Add `GET /v1/tasks/:taskId/composer-options` with raw `ModelInfo[]`, pinned
     permission modes, and SDK-resolved effort/default state.
   - Observe `system/init`/`system/status` only for readiness/control metadata
     while yielding the same SDK objects unchanged.
   - Test model-specific effort lists, SDK unknown fields, default effort, and
     failed initialization.
   - Do not add command, skill, agent, MCP, context-usage, background-task, or
     account endpoints in this task.

9. **Align live controls with Claude Code**
   - Add `ClaudeSdkSession.setEffortLevel()` backed by
     `applyFlagSettings()`; isolate the `max` type mismatch inside this adapter.
   - Add the idempotent effort HTTP route and schema.
   - Remove the product-level idle rejection from model changes; model, mode,
     and effort controls may run during an active turn and affect the next one.
   - For `claude-session` tasks, keep selector state live rather than persisting
     a second PocketPilot preference. Preserve existing explicit-task initial
     controls.
   - Serialize controls and raw input per task; document that clients await a
     control response before sending when order matters.
   - Propagate SDK rejection without PocketPilot fallback or Query recreation.

10. **Register and document the `/v1` session surface**
    - Add authenticated new-conversation, session list, history, and attach routes with a
      `Sessions` OpenAPI tag.
    - Add executable Zod schemas that are passthrough/open for SDK-owned
      metadata and history elements.
    - Update OpenAPI `x-websocket` notes for attach-before-activation while
      retaining raw SDK message schemas and close codes.
    - Document latest-first 50-message history pages, `beforeUuid`, stale/retry
      behavior, authorization, system-message inclusion, composer sequencing,
      SDK parse-cost limits, SDK version ownership, and history/live UUID
      reconciliation.
    - Regenerate deterministic `dist/openapi/mobile-v1.json`.

11. **Run security, storage, and cross-layer verification**
    - Route-test Bearer authentication and device revocation on every new
      operation.
    - Inspect tasks, audit records, operation results, event overflow, errors,
      and logs for summaries, prompts, message bodies, tool content, and local
      unauthorized paths.
    - Prove raw SDK/control channel negative isolation after attachment.
    - Test recovery, transparent reattachment, conflict handling, interrupt,
      approval, close, shutdown, and concurrent attach/send/control races.

12. **Update executable Trellis specs**
    - Record SDK session discovery/history contracts, worktree authorization,
      transparent attachment, runtime uniqueness, control timing, effort
      handling, and composer-option ownership.
    - Update task-runtime, Claude-SDK, API-documentation, database, error, and
      quality references without weakening the raw message contract.

## Validation Commands

Focused checks during implementation:

```powershell
pnpm vitest run test/claude-sdk/session.test.ts test/claude-sdk/live-contract.test.ts
pnpm vitest run test/tasks/task-manager.test.ts test/storage/database.test.ts
pnpm vitest run test/remote-api/task-routes.test.ts test/remote-api/task-sdk-routes.test.ts test/api-docs/mobile-openapi.test.ts
```

Full gate before review/commit:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:release:windows
```

Run the opt-in installed SDK contract only when local Claude credentials and
the user's intended billing/network environment permit it:

```powershell
$env:CLAUDE_SDK_LIVE='1'
pnpm vitest run test/claude-sdk/live-contract.test.ts
```

Generate OpenAPI twice and compare hashes, inspect the packed artifact, and
verify the generated contract contains no real session summary, prompt,
message, machine path, credential, or tool content.

## Validation Matrix

| Area | Required assertions |
| --- | --- |
| Catalog | Authorized directory uses SDK listing, programmatic sessions are included, worktrees are excluded, SDK metadata fields survive unchanged |
| History | Selected session is validated first; latest/older 50-message pages remain chronological and unchanged, cursor/filter/failure behavior is stable, and reads stay off the Query lane |
| New conversation | Every authorized workspace can start an empty-history Query with native Claude defaults and no resume ID |
| Attachment | Selection reuses one non-terminal runtime and needs no user-visible task/continue step |
| Query bootstrap | Raw subscriber is installed before activation; original `system/init` reaches the socket |
| Continuation | Raw user input resumes the selected SDK session and does not start a different transcript |
| Controls | Model/mode/effort modify the running Query, affect the next turn, and never recreate it or ride inside Send |
| SDK ownership | Models/effort levels/modes and errors come from installed SDK/Claude Code rather than a mobile catalog or fallback |
| Capacity | Idle attachment uses no active slot; a query-triggering message still enforces configured capacity |
| Uniqueness | Partial index and manager lane prevent two non-terminal PocketPilot Queries from owning one SDK session |
| Privacy | No session/history/live content enters durable PocketPilot storage, logs, audits, or idempotency results |
| Documentation | OpenAPI names SDK `0.3.210`, documents new REST routes, and keeps raw/control WebSockets separate |
| Packaging | Full build, deterministic OpenAPI, packed runtime, and Windows smoke pass |

## Risk and Rollback Points

| Risk | Mitigation / rollback |
| --- | --- |
| SDK directory lookup includes out-of-root worktrees | Force `includeWorktrees: false`, recheck returned cwd, and secure-fallback enumerate when single-session cwd is absent |
| History and live frames overlap or leave a race gap | Keep both SDK shapes; client refreshes/deduplicates by UUID rather than server transcript synthesis |
| SDK pagination still parses the full long transcript | Bound responses/UI work, serialize same-session reads, retain no full cache, and keep Query/composer usable on slow/failing history |
| Conversation chain changes between older-page requests | Anchor with `beforeUuid`; return `HISTORY_CURSOR_STALE` and reload latest instead of returning a wrong slice |
| `system/init` is missed before WebSocket subscription | Subscribe first, activate second; add an ordering regression |
| New conversation accidentally inherits PocketPilot defaults or resume state | Use `claude-session` origin, omit all initial control overrides, and assert no `resume` option |
| `max` is documented at runtime but omitted from generated Settings type | One narrow adapter boundary plus opt-in bundled-CLI contract test; no general unsafe casts |
| Control arrives during an active turn | Rely on SDK next-turn semantics; serialize per task and never mutate the current raw message |
| Duplicate legacy task/session mappings break uniqueness | Migration keeps newest non-terminal owner and terminals older internal owners before adding the partial unique index |
| Attached runtime replays PocketPilot control preferences after restart | Persist origin and omit model/mode overrides for `claude-session` Query creation |
| Migration rollback meets nullable attached rows | Treat schema as the rollback boundary; retain forward-compatible nullable reads or remove/terminalize only internal attached rows before older code |
| SDK content leaks through attachment idempotency | Persist task metadata only; never include `SDKSessionInfo` or messages in operation results |

## Review Gates

- Do not run `task.py start`, create a feature branch, or edit product code until
  the user reviews `prd.md`, `design.md`, and this plan.
- After migration/runtime attachment work, pass storage and uniqueness tests
  before adding routes.
- After raw-socket activation work, prove `system/init` passthrough and
  SDK/control negative isolation before adding composer controls.
- Before commit, run the complete Trellis quality check and Windows release
  smoke test.
