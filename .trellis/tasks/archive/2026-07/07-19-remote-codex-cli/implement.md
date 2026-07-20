# Provider-extensible Agent API implementation plan

## Preconditions

- Keep the task in `planning` until the user approves `prd.md`, `design.md`,
  and this plan.
- Before editing source, load the backend Trellis specs through
  `trellis-before-dev`, including directory structure, quality, error handling,
  database, process runtime, logging, API documentation, device auth, and task
  runtime contracts.
- Treat the current Claude SDK message types, task data, and replay behavior as
  a provider-behavior boundary. The old Claude-specific public routes are
  replaced by the common Agent API during the migration cutover.

## Implementation sequence

The common provider work in steps 1-4 is the foundation for, not a replacement
for, the Codex work in steps 5-10. The complete Codex App Server bridge,
catalog/history, turn lifecycle, native stream, concurrent approvals, composer
controls, reconnect, and live-contract scope remains required.

Execution is split into two child tasks:

- `07-20-agent-api-claude-migration` owns steps 1-4 and the corresponding
  common/Claude specification and documentation work from step 11.
- `07-20-codex-app-server-adapter` owns steps 5-10 and the corresponding Codex
  specification and documentation work from step 11. It cannot start until the
  first child has established the provider contract, provider-aware persistence,
  and common task stream boundary.

### 1. Define the common Agent provider contract

- Add a provider-neutral package boundary, such as
  `src/agent-providers/`, with no provider-specific imports in the registry or
  common API modules.
- Define provider descriptors, capability snapshots, task references, common
  conversation metadata, adapter lifecycle methods, and native stream handles.
- Define provider availability states: `available`, `not_installed`, `disabled`,
  `unhealthy`, and `unsupported_version`. Keep remote reason codes stable and
  diagnostics-safe.
- Keep provider installation, enablement, disablement, and configuration on the
  local administration surface. The remote Agent API is read-only for provider
  registry state.
- Keep `unknown` confined to the registry boundary; each adapter owns its typed
  native codec, history rows, events, approvals, and errors.
- Define explicit unsupported-capability errors. The common layer must never
  emulate a missing native behavior.
- Add an in-memory registry fixture with a fake provider to prove that adding a
  provider does not require changes to common task routing.

Validation:

```powershell
pnpm vitest run test/agent-providers/registry.test.ts
pnpm typecheck
```

Rollback point: this step adds types and registry tests only; existing Claude
runtime and routes remain untouched.

### 2. Add provider-aware persistence

- Add an explicit provider field to task metadata with an additive migration.
- Store each provider's native conversation/session identifiers in a provider
  runtime table or provider-owned metadata; do not repurpose Claude
  `sdkSessionId`.
- Preserve the existing Claude session uniqueness constraint and add separate
  native-identity constraints for Codex and future providers.
- Keep provider-specific active-turn and pending-request state out of the common
  task row unless restart semantics prove it is safe to persist.
- Test legacy database migration, default Claude rows, duplicate native owners,
  terminalization, shutdown, and provider isolation.

### 3. Register Claude as the first adapter

- Wrap the current Claude session catalog, Query session, controls, approval
  gate, and SDK event journal behind `ClaudeProviderAdapter`.
- Preserve all raw Claude payloads and SDK behavior inside the adapter while
  replacing `/v1/sessions` and `/v1/tasks/{taskId}/sdk` with the common Agent
  routes.
- Keep Claude `SDKMessage`, `SDKUserMessage`, `session_id`, `priority`,
  `shouldQuery`, UUID replay, and single `CanUseTool` approval semantics inside
  the Claude adapter.
- Move only provider selection and common task ownership into the new manager;
  do not normalize Claude messages into a common event union.
- Run the complete offline and live Claude test suites through the new common
  routes before adding Codex.

Rollback point: disable the provider registry release and restore the previous
application version through deployment rollback; no Claude protocol or
provider-owned storage data should be rewritten.

### 4. Add the common Agent API and perform the direct cutover

- Add provider discovery and capability routes, for example:
  `GET /v1/providers` and `GET /v1/providers/{providerId}/capabilities`.
- Return every registered provider from discovery, including unavailable rows;
  expose detected protocol version and capabilities only when trustworthy.
- Add or retain local-administration mutations for provider registration state;
  do not add remote install/enable/disable/configuration endpoints.
- Add common conversation routes under the provider-qualified namespace:
  `GET/POST /v1/providers/{providerId}/conversations`,
  `GET /v1/providers/{providerId}/conversations/{conversationId}`, and
  `POST /v1/providers/{providerId}/conversations/{conversationId}/attach`.
- Add a common task stream route such as `/v1/tasks/{taskId}/agent` that selects
  the adapter from task metadata and emits that provider's native frames.
- Migrate the mobile client to the common routes in the same release.
- Remove `/v1/sessions` and `/v1/tasks/{taskId}/sdk` from route registration,
  OpenAPI, and route tests. Do not add compatibility aliases.
- Migrate persisted Claude task metadata to the provider-aware representation;
  existing Claude sessions remain usable through the Claude adapter.
- Document that common responses contain only stable metadata and page/cursor
  information; history rows and stream frames use provider-specific schemas.
- Update OpenAPI with provider descriptors, capabilities, common task metadata,
  and links to each native stream contract.
- Test authentication, provider selection, unsupported providers, capability
  negotiation, all provider availability states, redacted reason codes,
  cross-provider task isolation, direct mobile cutover, and native Claude
  behavior through the new routes.

### 5. Establish the Codex protocol boundary

- Add a separate Codex package with no imports from the Claude adapter.
- Define base JSON-RPC request, response, error, notification, and
  server-request guards. Preserve unknown provider notification/item fields.
- Define a strict allowlist for mobile-originated methods and validate all
  method-specific path-bearing parameters.
- Add a CLI version/capability probe using `codex --version` and the App Server
  initialization handshake.
- Add fixtures generated from a caller-provided Codex installation; never commit
  a developer executable path or temporary schema directory.
- Unit-test invalid JSONL, duplicate IDs, unknown methods, pre-initialize use,
  process exit, stderr isolation, request timeout, and version mismatch.

### 6. Implement the Codex stdio bridge and adapter

- Spawn `codex app-server --listen stdio://` directly with piped stdin/stdout
  and captured diagnostic stderr.
- Serialize one JSON object per stdin line and parse one stdout line per frame.
- Complete `initialize` and `initialized` exactly once per bridge process.
- Correlate normal requests/responses, route notifications/server requests by
  native thread ID, and maintain bounded write queues.
- Implement deterministic shutdown and failure propagation without leaking child
  processes or pending requests.
- Add `CodexThreadCatalog` for `thread/start`, `thread/list`, `thread/read`, and
  `thread/resume`.
- Include `cli`, `vscode`, and `appServer` sources; filter returned cwd rows with
  the common workspace policy.
- Prefer experimental turn/item pagination when explicitly available and use a
  bounded full-read fallback otherwise.

### 7. Implement provider-neutral Codex task lifecycle

- Bind `taskId` to Codex `threadId`, `sessionId`, and active `turnId` without
  putting those IDs in Claude fields.
- Create a task only after `thread/start` returns a thread ID.
- Attach/reuse an existing thread after authorization and `thread/resume`.
- Route idle input to `turn/start`; route active input to
  `turn/steer(expectedTurnId)`.
- Route interrupt to `turn/interrupt(threadId, turnId)` and wait for native
  `turn/completed`.
- Map common close to detach/unsubscribe and runtime cleanup; keep archive/delete
  as distinct native Codex operations.
- Reuse common P0/P1/P2 scheduling, capacity, idempotency, shutdown, and audit
  logic without translating Claude priority fields.

Test start, attach/reuse, active-turn steer preconditions, interrupt, close,
bridge exit, restart recovery, capacity, workspace revocation, and provider
cross-talk.

### 8. Implement native Codex stream replay and approvals

- Add a provider journal that retains native JSON-RPC frames using an internal
  monotonic sequence outside provider messages.
- Reuse encrypted-overflow and replay-size-cap storage through a common journal
  interface, but do not reuse Claude UUID indexing.
- Retain unresolved server requests and replay them only while still valid.
- Add a Codex pending-request map scoped to device, task, thread, turn, item, and
  method; support concurrent command/file approvals first.
- Preserve native decisions such as `acceptForSession`, cancellation,
  exec-policy/network amendments, and permission subsets.
- Clear pending requests and replay on provider response, resolution, turn
  finish, interrupt, close, revocation, bridge exit, and shutdown.
- Test cursor replay, stale cursors, disconnect during streaming, unresolved
  approval reconnect, overflow, concurrent requests, stale responses, and
  negative Claude/Codex/control cross-delivery.

### 9. Implement provider-specific composer controls

- Codex models and reasoning effort come from `model/list`.
- Codex approval policy, sandbox policy, permission profile, and collaboration
  mode remain separate provider-specific schemas.
- Every Codex cwd/read/write root passes common workspace authorization.
- Common capability responses expose which controls the selected provider
  actually supports; unsupported controls return explicit errors.
- Test Codex model/effort changes, experimental collaboration mode, sandbox root
  rejection, and ordering before send.

### 10. Add live and contract tests for extensibility

- Add an explicit `pnpm test:codex:live` runner that requires a caller-provided,
  absolute `CODEX_APP_SERVER_TEST_CWD` and skips during ordinary `pnpm test`.
- Prove Codex initialization, model discovery, immediate thread ID allocation,
  streamed agent delta, approval or sandbox boundary, interrupt, history read,
  resume, `appServer` source visibility, and clean bridge shutdown.
- Add a fake provider contract suite that every future adapter must pass for
  provider discovery, capability negotiation, create/attach, stream routing,
  interrupt, close, unsupported operations, and isolation.
- Keep Claude offline/live provider contract tests unchanged and run them before
  and after the direct route migration.

### 11. Update specifications and operational documentation

- Add backend specs for provider registry, common Agent API, provider-aware task
  identity, native stream contracts, multi-request approvals, and capability
  negotiation.
- Document how to add a new OpenCode, Pi, or other Agent adapter without editing
  common routes and lifecycle code.
- Document Codex CLI prerequisites, environment variables, stable/experimental
  methods, and native payload ownership.
- Generate/update API documentation without local paths, secrets, or provider
  payload leakage.

## Full validation gate

Run after the final implementation iteration:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:codex:live
```

Also run focused migration, task runtime, remote API, event journal, logging,
device-auth, and OpenAPI tests after each affected layer changes.

## Review gates

- Do not start implementation until the user approves the planning artifacts and
  the Trellis task is started.
- Review the provider contract and task migration before adapting Claude.
- Review Claude native-behavior regression tests before enabling common routes.
- Review the RPC allowlist and path authorization before enabling Codex streams.
- Review reconnect behavior before approval handling.
- Review live evidence before claiming local Codex parity.

## Final rollback strategy

- Disable a provider registration and stop its runtime bridge.
- Leave provider-owned logs and local configuration unchanged.
- Keep additive provider metadata for a later retry or remove it only through a
  separately reviewed migration.
- Existing Claude tasks and sessions continue through the new Claude adapter;
  the removed Claude-specific routes are not restored.
