# Claude Agent SDK Contracts

## Scenario: Raw, Long-Lived Claude Agent SDK Session

### 1. Scope / Trigger

Apply this contract when code creates, resumes, controls, or transports messages
for the pinned `@anthropic-ai/claude-agent-sdk@0.3.210` `Query`. The installed
SDK owns the conversation wire types; PocketPilot must not create a normalized
or mobile-specific conversation model.

The SDK closes Claude CLI stdin when its input `AsyncIterable` completes.
Creating a finite stream per turn terminates the interactive session and makes
later SDK user messages unreliable.

### 2. Signatures

```ts
openClaudeSdkSession(options: {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  canUseTool?: CanUseTool;
}): ClaudeSdkSession;

session.submit(message: SDKUserMessage): void;
session.events(): AsyncGenerator<SDKMessage>;
session.initialize(): Promise<{
  initialization: SDKControlInitializeResponse;
  models: ModelInfo[];
}>;
session.setEffortLevel(level: EffortLevel | null): Promise<void>;
readLiveSdkTestConfig(environment?):
  | { enabled: false }
  | { cwd: string; enabled: true };

catalog.list(options: ListSessionsOptions): Promise<SDKSessionInfo[]>;
catalog.getInfo(sessionId, options): Promise<SDKSessionInfo | undefined>;
catalog.getMessages(sessionId, options): Promise<SessionMessage[]>;
catalog.resolveSettings(options): Promise<ResolvedSettings>;

type SerializableCanUseToolRequest = {
  toolName: Parameters<CanUseTool>[0];
  input: Parameters<CanUseTool>[1];
  options: Omit<Parameters<CanUseTool>[2], "signal">;
};

new ClaudeProviderAdapter(taskManager, eventJournal): AgentProviderAdapter;
```

`ClaudeSdkInputStream` is the one task-scoped
`AsyncIterable<SDKUserMessage>` supplied to `query({ prompt })`. It has one SDK
consumer and remains open until task close or coordinated shutdown.

### 3. Contracts

- Submit the original accepted `SDKUserMessage` object to the existing input
  stream. Do not synthesize it from a PocketPilot instruction string, require
  optional `uuid` or `session_id`, add `operationId`, rename fields, or remove
  unknown SDK extension fields.
- `ClaudeSdkSession.events()` yields every `SDKMessage` from Query unchanged,
  including `user`, `assistant`, `stream_event`, `result`, system, tool, and
  future/open variants. It may observe `session_id` before yielding, but it
  must not wrap, clone, filter, project, or normalize the message.
- Every new and resumed Query sets `Options.includePartialMessages` to `true`
  so the SDK emits raw `stream_event` deltas before the final authoritative
  `assistant` message. PocketPilot never fabricates token-by-token output.
- `ClaudeProviderAdapter` owns the Claude-native side of
  `/v1/tasks/{taskId}/agent`. The WebSocket is JSON serialization around those
  two SDK-owned types. PocketPilot task state, approval notifications, cursors,
  task IDs, and timestamps are not SDK messages and never appear as wrappers on
  that socket.
- The route's exported `sdkUserMessageTransportSchema` validates only the
  stable base contract and known optional primitive fields, is passthrough for
  SDK extensions, and returns the original parsed object. The package's
  TypeScript definitions remain the full source of truth.
- Preserve `priority` and `shouldQuery` exactly. The task runtime may observe
  `shouldQuery` for capacity and lifecycle accounting, but the SDK owns message
  ordering, interruption, queuing, and processing.
- Observe `SDKMessage.session_id` as the resumable SDK-session reference.
  Hook messages can precede `system:init`; neither `Query` nor
  `initializationResult()` exposes the session ID directly.
- Store only the session ID and task metadata. No SDK input/output belongs in
  Agent transcript tables, operation results, audit content, or logs.
- Proxy `CanUseTool` without renaming: serialize `toolName`, `input`, and every
  option except `signal`. Keep the `AbortSignal` local and return the complete
  received `PermissionResult` object unchanged to the waiting callback.
- Forward `Options.resume`, initial model, and permission mode when opening a
  session. Existing live sessions use `setModel()` and
  `setPermissionMode()`; product state rules remain in `TaskManager`.
- Discover and read local Claude sessions only through `listSessions`,
  `getSessionInfo`, and `getSessionMessages`. Never locate or parse
  `~/.claude` files. Preserve every returned `SDKSessionInfo` and
  `SessionMessage` object; pagination cursors remain outside SDK rows.
- The provider-neutral conversation API converts Claude list offsets and
  history UUIDs into the common string cursor envelope without cloning,
  filtering, or normalizing any `SDKSessionInfo` or `SessionMessage` row.
- Session-centric Queries omit PocketPilot model, permission-mode, and effort
  startup overrides. A selected session supplies only `Options.resume` and no
  PocketPilot entrypoint override. A new conversation supplies cwd plus a
  copied child environment containing
  `CLAUDE_CODE_ENTRYPOINT=pocketpilot`. Install the raw subscriber before
  opening either Query so the original `system/init` reaches the client
  unchanged.
- The new-conversation child environment inherits every current process value,
  overrides only `CLAUDE_CODE_ENTRYPOINT`, and never mutates `process.env`.
  `pocketpilot` truthfully identifies the creating host; never use `cli` to
  impersonate a terminal session. Resume the selected SDK session ID without a
  fork or reclassification.
- For the pinned SDK, `listSessions({ includeProgrammatic: false })` is the
  documented terminal `/resume` parity filter. A new PocketPilot session must
  appear there before and after TaskManager resumes the same ID. Treat this as
  an SDK/Claude Code upgrade gate because `CLAUDE_CODE_ENTRYPOINT` is an
  installed-runtime contract rather than a documented SDK option.
- Existing `sdk-ts` sessions remain available through PocketPilot's inclusive
  catalog and are not migrated. Never edit Claude-owned transcript metadata to
  change their visibility.
- Query composer discovery uses `supportedModels()` and each model's
  `supportedEffortLevels`; permission choices cover every pinned SDK
  `PermissionMode`. The returned model list is a composer catalog, not an
  exhaustive validation set for locally configured models; the active
  `system:init.model` may be absent from it. Observe raw
  `system:init`/`system/status` for actual model and permission state instead
  of projecting those messages or selecting `models[0]` as current state.
- `initializationResult()` and `supportedModels()` may resolve before a resumed
  Query publishes raw `system:init`. Install the raw subscriber first, but do
  not require activation alone to emit init; the first streaming input starts
  raw delivery. A live contract may use `shouldQuery: false` to prove this
  boundary without consuming another model turn.
- Forward live model/mode/effort controls through `setModel()`,
  `setPermissionMode()`, and `applyFlagSettings()` on the existing streaming
  Query. They may run during an active turn and apply to the next turn; never
  reopen Query or attach controls to the next `SDKUserMessage`.
- `EffortLevel` and model discovery can include `max`, while generated
  `Settings.effortLevel` omits it. Keep the one compatibility cast inside
  `ClaudeSdkSession.setEffortLevel()` and still call
  `applyFlagSettings({ effortLevel })`; never substitute deprecated
  `setMaxThinkingTokens()`.
- The dedicated `pnpm test:sdk:live` runner sets `CLAUDE_SDK_LIVE=1` only for
  its Vitest child and requires `CLAUDE_SDK_TEST_CWD` to name an absolute,
  existing directory. Ordinary `pnpm test` remains offline and skips the live
  scenario. Never commit a developer's concrete workspace or read its Claude
  configuration directly.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Input stream is closed | Reject later `submit`; never reopen it or create an implicit Query. |
| A second consumer iterates the input stream | Throw; the one Query owns the consumer. |
| Client frame is invalid JSON, binary, or fails the SDK base guard | Close raw SDK socket with `4000 / SDK_MESSAGE_INVALID`; submit nothing. |
| Optional `uuid`, `session_id`, or PocketPilot `operationId` is absent | Accept the valid SDK user message; PocketPilot identifiers are not required in its body. |
| SDK yields a `user` or newly introduced message variant | Yield and transport the same object; never silently omit it. |
| SDK aborts a pending tool approval | Reject with `ToolApprovalCancelledError`; do not serialize the signal or silently allow. |
| Complete allow/deny `PermissionResult` arrives | Resolve the SDK callback with that result, including optional SDK fields. |
| Requested permission mode is absent from the pinned SDK | Return `UNSUPPORTED_PERMISSION_MODE`; never fall back to another mode. |
| SDK rejects model, permission, or effort | Return the control failure; retain the current Query and perform no PocketPilot fallback. |
| Session catalog/history API fails | Translate to a safe task-domain error; never expose an SDK exception or local path. |
| `max` effort is selected | Forward through the narrow live-settings adapter; do not reject a model-advertised SDK value. |
| Live mode has no valid absolute test workspace | Fail before constructing Query; name only `CLAUDE_SDK_TEST_CWD`, not its value. |
| Live Query emits `system/api_retry` | Preserve the raw event and allow a bounded retry window; diagnostics contain message categories only, never output content. |
| New PocketPilot session is absent with `includeProgrammatic: false` | Fail the live compatibility gate; do not fall back to `cli`, PTY automation, or transcript edits. |

### 5. Good / Base / Bad Cases

- Good: one open input stream accepts a raw message with `priority: "now"`,
  later accepts another while Claude is executing, and Query's raw messages
  reach the SDK socket with deep equality.
- Good: a selected session uses `Options.resume`, emits its original init
  object after subscription, accepts a live effort change, then receives only
  the next raw SDK user message.
- Good: a new Query receives the `pocketpilot` child entrypoint, appears under
  terminal `/resume` parity filtering, and remains there after the same session
  ID is resumed through TaskManager.
- Base: historical messages are fetched for display and never concatenated
  into a prompt; Claude Code alone restores and compacts context on resume.
- Base: an idle task receives `shouldQuery: false`; the SDK appends it without
  PocketPilot inventing an active turn, while the same session remains usable.
- Base: a resumed Query initializes composer controls before raw init, then a
  `shouldQuery: false` input causes the unchanged init to reach the installed
  subscriber before the next query-triggering input.
- Bad: converting input from `{ instruction }`, dropping `user` output, or
  sending `{ kind: "sdk", payload: message }`. Each creates a second protocol
  that drifts from the installed SDK.
- Bad: treating `supportedModels()[0]` as the current model or rejecting the
  raw init model because it is absent from that catalog.
- Bad: labeling a PocketPilot Query as `cli`, applying the PocketPilot
  entrypoint override to `Options.resume`, or rewriting a legacy transcript's
  provenance.

### 6. Tests Required

- Unit-test that the input stream preserves object identity, accepts later
  messages, closes deterministically, and rejects a push after close.
- Deep-equality-test representative user, assistant, stream, result, system,
  tool-progress, and open SDK output categories; assert no category is filtered.
- Test the transport guard with missing optional identifiers, scheduling and
  unknown fields, invalid JSON/base fields, and binary frames.
- Test every serializable `CanUseTool` option and complete allow/deny
  `PermissionResult`, plus SDK abort, replacement, interrupt, close, and
  shutdown cancellation.
- Keep an opt-in `pnpm test:sdk:live` scenario for the pinned package that
  requires `CLAUDE_SDK_TEST_CWD`, discovers initialization/models, submits
  multiple messages on one stream, changes controls between turns, resumes the
  same session through `TaskManager`, proves that ID remains visible with
  `includeProgrammatic:false`, and interrupts/shuts down cleanly. The runner
  owns `CLAUDE_SDK_LIVE=1`; default tests assert the live scenario is skipped.
- Unit-test catalog option forwarding and object identity, effort including
  `max`/null, Query defaults versus resume, and subscribe-before-activation
  delivery of unwrapped `system/init`.
- Unit-test that both new and resumed Query factories receive
  `includePartialMessages: true`.
- Unit-test that only new Queries receive a copied environment with the
  `pocketpilot` entrypoint; resume Queries receive the original session ID and
  no PocketPilot environment override.

### 7. Wrong vs Correct

#### Wrong

```ts
const event = normalizeSdkMessage(message);
controlJournal.publish(taskId, { kind: "sdk", payload: event });
session.submit(createSdkUserMessage(instruction));
```

This filters and renames SDK output and reconstructs SDK input from a second
PocketPilot conversation format.

#### Correct

```ts
session.submit(sdkUserMessage);

for await (const sdkMessage of session.events()) {
  sdkJournal.publishSdkMessage(taskId, sdkMessage);
}
```

The SDK owns both message contracts; PocketPilot supplies only authenticated,
task-scoped transport and lifecycle policy.

#### Wrong: Reclassify every Query

```ts
const env = {
  ...process.env,
  CLAUDE_CODE_ENTRYPOINT: options.resume ? "cli" : "pocketpilot",
};
```

This impersonates the terminal and applies a new classification while resuming
an existing Claude-owned session.

#### Correct: Label only new PocketPilot conversations

```ts
const entrypointEnvironment =
  options.resume === undefined
    ? {
        env: {
          ...process.env,
          CLAUDE_CODE_ENTRYPOINT: "pocketpilot",
        },
      }
    : {};
```

The creating host is truthful, the parent environment stays unchanged, and a
selected session continues under its original ID/provenance.
