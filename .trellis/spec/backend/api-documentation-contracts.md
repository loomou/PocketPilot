# Mobile API Documentation Contracts

## 1. Scope / Trigger

Apply this contract when changing a remote `/v1` HTTP route, its Zod schemas,
Bearer authentication metadata, either WebSocket protocol, local
Swagger delivery, or packaged production assets. The executable Fastify/Zod
contracts must remain the single source of truth for mobile integration docs.

## 2. Signatures

```ts
buildRemoteApiApp(options?): Promise<FastifyInstance>;
buildMobileOpenApiDocument(): Promise<OpenAPIV3.Document>;
buildLocalAdminApp({ mobileOpenApiDocument?, ... }): Promise<FastifyInstance>;

eventSubscriptionMessageSchema: ZodType;
eventSubscribedMessageSchema: ZodType;
eventDeliveryMessageSchema: ZodType;
eventErrorMessageSchema: ZodType;
sdkUserMessageTransportSchema: ZodType;
agentProviderDescriptorSchema: ZodType;
agentWebSocketClose: Record<string, { code: number; reason: string }>;
```

Documentation endpoints are local-only: `GET /documentation/`,
`GET /documentation/json`, and `GET /documentation/yaml`. The production build
emits `dist/openapi/mobile-v1.json`.

## 3. Contracts

- Register `@fastify/swagger` on the unbound remote app before registering
  routes, using `jsonSchemaTransform` and OpenAPI `3.1.0`.
- Every documented route derives request and response schemas from the same Zod
  objects used at runtime. Route schemas also declare a stable operation ID,
  tag, summary, description, error-body shape, and Bearer security where
  access-token authentication is required.
- `GET /v1/workspaces` documents the Bearer-protected configured workspace
  list as `{ workspaceRoots: string[] }`. Its response schema is derived from
  `taskRuntimeSettingsSchema.pick({ workspaceRoots: true })`, matching the
  settings owner used by task authorization.
- The `Providers` and `Conversations` tags own protected provider discovery,
  capability, list/create/read/attach routes under
  `/v1/providers/{providerId}/conversations`. Document common workspace
  authorization, transparent attachment, the opaque task transport handle,
  and that each provider owns its native conversation rows.
- History documentation specifies chronological latest/older pages of at most
  50 using the common `page.cursor`/`page.hasMore` envelope,
  `includeSystemMessages` consistency, stale-cursor reload, repeated local
  provider parse cost, and client-side virtualization/history-live UUID
  deduplication. Claude's cursor is an SDK offset for list pages and a message
  UUID for history pages.
- Composer documentation owns `GET /v1/tasks/{taskId}/composer-options` and
  `POST /v1/tasks/{taskId}/effort` alongside model and permission routes. State
  that controls update the existing Query for the next turn and must complete
  before Send when ordering matters; Send remains a raw SDK user message.
- Generate the complete document with structural no-op service dependencies.
  `app.ready()` may build the route graph, but documentation generation must
  never bind sockets, open storage, launch Claude, or require a real key.
- The document covers only the remote versioned `/v1` contract. It excludes
  `/healthz`, `/admin/*`, `/_internal/*`, local status/control data, and real
  credential or machine examples.
- The remote app owns the Swagger generator decorator but registers no Swagger
  UI or documentation route. The local app registers the supplied document in
  static mode and serves Swagger UI only on its loopback listener.
- Document two isolated WebSockets. `/v1/events` uses exported runtime Zod
  schemas for PocketPilot subscribe/subscribed/event/error messages and never
  claims to carry provider conversation data. `/v1/tasks/{taskId}/agent` carries
  provider-native client and server frames; Claude uses raw `SDKUserMessage`
  and `SDKMessage` objects.
- The Agent WebSocket extension identifies Claude's
  `@anthropic-ai/claude-agent-sdk@0.3.210` as the wire-contract owner. Reuse the
  exported `sdkUserMessageTransportSchema` for the documented base guard;
  describe SDK output as an open SDK-owned object instead of hand-copying its
  evolving union into Zod.
- Document `afterCursor`, absent/unknown replay fallback, no PocketPilot wrapper,
  and close codes `4000`, `4003`, `4004`, `4009`, and `4011`. Keep
  `afterCursor` and `EVENT_SUBSCRIPTION_INVALID` specific to the control
  socket.
- Document subscribe-before-activation for session-centric runtimes without
  changing the raw WebSocket schemas or adding an SDK envelope.
- Document approval controls with every serializable `CanUseTool` option and
  the HTTP resolution request's complete `PermissionResult`; explicitly state
  that `AbortSignal` remains local. The response remains the shared
  `taskOperationResultSchema` metadata shape rather than echoing the SDK
  permission decision.
- `pnpm build` writes deterministic, pretty-printed JSON. The packed tarball
  includes the same artifact and all Swagger runtime dependencies.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Generated document is not OpenAPI 3.1 | Fail generation; emit no accepted contract. |
| A protected route lacks valid access credentials at runtime | Existing stable `{ code, message }` response; docs declare `bearerAuth`. |
| Local request targets `/documentation/` or raw JSON/YAML | Return the local Swagger resource when a document was supplied. |
| Remote request targets any documentation URL | HTTP 404. |
| Generated path begins with `/admin/` or `/_internal/` | Quality check fails; do not ship the document. |
| WebSocket handshake authentication/revocation fails | Close with `4003`, as recorded in `x-websocket`. |
| WebSocket subscription message is malformed | Send the shared `EVENT_SUBSCRIPTION_INVALID` error message. |
| Raw SDK frame fails the exported base schema | Close `4000 / SDK_MESSAGE_INVALID`; emit no JSON error frame. |
| SDK task is missing or unavailable | Close `4004 / TASK_NOT_FOUND` or `4009 / TASK_SESSION_UNAVAILABLE`. |
| SDK transport fails unexpectedly | Close `4011 / SDK_TRANSPORT_FAILED`; expose no internal exception text. |
| Repeated generation from unchanged source differs byte-for-byte | Treat as a build-quality failure. |
| Session/history/control route lacks Bearer security or a stable operation ID | Fail the OpenAPI path-set/operation audit. |
| SDK-owned row schema strips an unknown field | Fail route serialization tests; keep the runtime schema passthrough. |

## 5. Good / Base / Bad Cases

- Good: changing the raw SDK input base guard updates runtime validation,
  `x-websocket`, local Swagger, and packaged JSON from the exported Zod owner.
- Good: adding an SDK session field requires no PocketPilot schema rewrite;
  passthrough runtime serialization and the open OpenAPI row preserve it.
- Base: the unbound remote app without domain dependencies exposes only health
  at runtime and no documentation route; the documentation factory supplies
  no-op dependencies to register the complete `/v1` graph.
- Bad: documenting `{ kind: "sdk", payload }`, maintaining a hand-copied SDK
  union, registering Swagger UI remotely, or documenting input separately from
  the exported transport schema.

## 6. Tests Required

- Generate twice and assert deterministic serialization, OpenAPI `3.1.0`, the
  expected complete `/v1` path set, unique operation IDs, and `bearerAuth`.
- Assert generated JSON contains no `/admin/*`, `/_internal/*`, master/Claude
  key names, runtime-control credential, prompt, task output, or tool data.
- Validate representative WebSocket messages with the exported runtime Zod
  schemas; reject malformed control subscriptions and invalid/binary SDK
  frames.
- Assert the complete path set contains `/v1/tasks/{taskId}/agent`, omits
  `/v1/tasks/{taskId}/instruction`, includes protected `/v1/workspaces`, and
  names the approval parameter `requestId`.
- Assert the path set includes provider discovery/capabilities and
  provider-scoped conversation list/create/history/attach, composer options,
  and effort; descriptions include the SDK version, 50-row cursor
  behavior, history/live separation, and subscribe-before-activation.
- Assert capability schemas include closed `historyFilters` with boolean
  `includeSystemMessages` (Claude true / Codex false in product docs).
- Assert control docs contain no SDK server message, raw SDK docs contain no
  PocketPilot wrapper, and all approval fields and stable close codes appear.
- Local-app injection must return Swagger UI and the exact raw document while
  remote-app injection returns 404 for the same paths.
- `pnpm build`, tarball inspection, and the Windows packed-install smoke test
  must compare the packaged JSON with the running local raw document.

## 7. Wrong vs Correct

### Wrong

```ts
remoteApp.register(fastifySwaggerUi, { routePrefix: "/documentation" });
const responseSchema = { type: "object", properties: { id: { type: "string" } } };
```

This exposes integration tooling through the remote listener and creates a
parallel schema that can drift from runtime validation.

### Correct

```ts
route.schema.response = { 200: taskSnapshotSchema };
const document = await buildMobileOpenApiDocument();
await localApp.register(fastifySwaggerUi, { routePrefix: "/documentation" });
const sdkInput = z.toJSONSchema(sdkUserMessageTransportSchema);
```

The route reuses its domain Zod schema, one generator builds the document, and
only the loopback application serves the UI.
