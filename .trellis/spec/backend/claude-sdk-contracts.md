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

type SerializableCanUseToolRequest = {
  toolName: Parameters<CanUseTool>[0];
  input: Parameters<CanUseTool>[1];
  options: Omit<Parameters<CanUseTool>[2], "signal">;
};
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
- The raw task SDK WebSocket is JSON serialization around those two SDK-owned
  types. PocketPilot task state, approval notifications, cursors, task IDs, and
  timestamps are not SDK messages and never appear as wrappers on that socket.
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

### 5. Good / Base / Bad Cases

- Good: one open input stream accepts a raw message with `priority: "now"`,
  later accepts another while Claude is executing, and Query's raw messages
  reach the SDK socket with deep equality.
- Base: an idle task receives `shouldQuery: false`; the SDK appends it without
  PocketPilot inventing an active turn, while the same session remains usable.
- Bad: converting input from `{ instruction }`, dropping `user` output, or
  sending `{ kind: "sdk", payload: message }`. Each creates a second protocol
  that drifts from the installed SDK.

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
- Keep an opt-in `CLAUDE_SDK_LIVE=1` test for the pinned package that discovers
  initialization/models, submits multiple messages on one stream, changes
  controls between turns, and interrupts the session.

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
