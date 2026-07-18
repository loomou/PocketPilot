# Runtime Logging Contracts

## 1. Scope / Trigger

Apply this contract when adding or changing foreground process output, runtime
lifecycle diagnostics, pairing/auth events, HTTP/WebSocket diagnostics, task
state logs, or Claude SDK lifecycle observations. It keeps operational logs
useful without turning them into a second transcript or credential store.

## 2. Signatures

```ts
createPocketPilotLogger({
  level, destination?, environment?, color?, now?,
}): PocketPilotLogger;

logger.child(fields): PocketPilotLogger;
logger.debug(event, title, fields?): void;
logger.info(event, title, fields?): void;
logger.warn(event, title, fields?): void;
logger.error(event, title, fields?): void;

readLogLevel(environment): "debug" | "info" | "warn" | "error";
```

`runStartCommand` creates one logger and passes it through `AgentRuntime` to
auth, HTTP/WebSocket, and task/SDK owners. Component options may omit the
logger only for isolated tests or unbound documentation composition; the
fallback is `noopLogger`.

## 3. Contracts

- `POCKETPILOT_LOG_LEVEL` is an allowlisted startup dotenv key. The default is
  `info`; valid explicit values are `debug`, `info`, `warn`, and `error`.
- Pino owns record levels and filtering. `PocketPilotLogger` is the only
  application-facing logger and accepts only safe scalar fields. Do not pass a
  raw request, response, SDK message, error object, settings object, or payload.
- Foreground records go to stderr in a human-readable layout: local timestamp,
  colored level, concise title, stable bracketed event name, and aligned
  metadata. `DEBUG` is cyan, `INFO` green, `WARN` yellow, and `ERROR` red.
- ANSI color is enabled only for a TTY and is disabled when `NO_COLOR` exists.
  Redirected output contains no escape codes. PocketPilot creates no log file,
  log table, browser viewer, or remote log endpoint.
- Fastify remains `logger: false`. A shared hook emits route template, method,
  status, listener kind, and duration at `debug`; it never logs URL query text,
  headers, request/response bodies, or automatic Fastify request objects.
- Default `info` covers runtime/listener lifecycle, pairing stages, WebSocket
  connect/close, task state, approvals, and SDK Query boundaries. Expected
  security/state rejection is `warn`; unexpected runtime/SDK failure is
  `error`; request completion and safe message-category observations are
  `debug`.
- Successful source-development and built production startup each emit
  `Remote health: <url>/healthz` and `Local administration: <url>` as separate
  `info` records. The `.ts` source-development entrypoint additionally emits
  `Swagger documentation: <local-url>/documentation/`; bundled `.js`
  production execution omits only that Swagger record. Per-listener bind
  details remain `debug` to avoid duplicating the ready URLs at `info`.
- Stable event names live in `src/logging/events.ts`. Correlation may use
  pairing, device, task, and approval request IDs; the terminal formatter
  abbreviates UUIDs. Logs may also use route/listener kind, status/close code,
  operation, result, SDK type/subtype, UUID presence, and bounded counts.
- Never log master/new-master keys, encrypted envelopes, access/refresh or
  runtime-control credentials, CSRF tokens, pairing verification codes,
  signatures, device proofs/public keys, raw authorization headers, dotenv
  contents, full settings, workspace paths, Claude configuration, prompts,
  SDK payloads, transcript/history rows, tool input/output, or model output.
- `safeErrorFields` exposes only a stable error class and optional code. Do not
  send raw exception messages to the logger because SDK/filesystem errors may
  contain a prompt or machine path.
- `agent rekey` and `agent reset` retain their concise successful stdout
  contract. They never print key values, encrypted envelopes, database paths,
  or deleted contents.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Log level absent | Use `info`. |
| Log level is not `debug`, `info`, `warn`, or `error` | `ENVIRONMENT_VALUE_INVALID`; bind no listener. |
| Destination is not a TTY | Emit readable text without ANSI sequences. |
| `NO_COLOR` is present | Emit readable text without ANSI sequences even on a TTY. |
| A forbidden field name reaches the wrapper | Omit it; never serialize its value. |
| A title/field contains control characters or excessive text | Replace control characters and bound the scalar length. |
| HTTP auth/task operation is rejected | Log safe route/ID/status/code metadata; return the existing API error unchanged. |
| WebSocket auth/frame/task transport fails | Log the stable close code/reason only; never log the frame or credential. |
| SDK Query throws | Log safe error class/code and task ID; preserve existing task cleanup behavior. |

## 5. Good / Base / Bad Cases

- Good: a pairing trace shows create, registration, pending approval,
  `PAIRING_NOT_APPROVED`, approval, challenge, and claim under the same
  abbreviated pairing ID without showing the six-digit code or credentials.
- Good: a task trace shows idle -> executing -> awaiting approval -> executing
  -> idle, Query result, and socket cleanup without any user/tool/model text.
- Base: `agent start` at `info` shows lifecycle events while health polling is
  silent; setting `POCKETPILOT_LOG_LEVEL=debug` adds safe request completion.
- Bad: enabling Fastify's automatic logger, logging `{ request }`, spreading an
  SDK message/error into fields, or persisting terminal output in SQLite.

## 6. Tests Required

- Logger unit tests assert level filtering, readable alignment, UUID
  abbreviation, TTY colors, redirected/`NO_COLOR` behavior, control-character
  normalization, and forbidden field omission.
- Environment tests assert the allowlist, default, all valid levels, invalid
  values, process precedence, and no rejected value in the error message.
- Runtime tests capture startup/listener/request/shutdown events and prove the
  master key and runtime-control token are absent. They assert the two separate
  ready URLs in both modes, Swagger presence in development, and Swagger
  absence in production. Runtime command tests fix `.ts` versus `.js` mode
  detection.
- Pairing route tests trace registration, pre-approval rejection, approval,
  claim, and access authentication while proving verification code, access
  token, signature/public key, and request bodies are absent.
- WebSocket and TaskManager tests prove SDK/control payloads, prompts, model
  names, transcript results, and tool input never reach captured logs.

## 7. Wrong vs Correct

### Wrong

```ts
const app = Fastify({ logger: true });
logger.info({ request, sdkMessage, error }, "request failed");
```

This gives the logger arbitrary headers, bodies, credentials, Claude content,
and raw exception text.

### Correct

```ts
logger.warn(logEvents.authRequestRejected, "Authentication request rejected", {
  code: error.code,
  pairingId,
  route: request.routeOptions.url,
  statusCode: error.statusCode,
});
```

The record has a stable event and enough safe metadata to diagnose the stage
without copying the sensitive operation into another data channel.
