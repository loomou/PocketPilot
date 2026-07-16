# Mobile API Documentation Contracts

## 1. Scope / Trigger

Apply this contract when changing a remote `/v1` HTTP route, its Zod schemas,
Bearer authentication metadata, the task-event WebSocket protocol, local
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
- Generate the complete document with structural no-op service dependencies.
  `app.ready()` may build the route graph, but documentation generation must
  never bind sockets, open storage, launch Claude, or require a real key.
- The document covers only the remote versioned `/v1` contract. It excludes
  `/healthz`, `/admin/*`, `/_internal/*`, local status/control data, and real
  credential or machine examples.
- The remote app owns the Swagger generator decorator but registers no Swagger
  UI or documentation route. The local app registers the supplied document in
  static mode and serves Swagger UI only on its loopback listener.
- `/v1/events` uses the exported runtime Zod schemas for both socket parsing /
  sending and OpenAPI `x-websocket` message schemas. The extension records
  Bearer handshake authentication, close code `4003`, `afterCursor` replay,
  live handoff, and Swagger UI's non-executable limitation.
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
| Repeated generation from unchanged source differs byte-for-byte | Treat as a build-quality failure. |

## 5. Good / Base / Bad Cases

- Good: changing a route's Zod response updates runtime validation, local
  Swagger, and the packaged JSON through one contract owner.
- Base: the unbound remote app without domain dependencies exposes only health
  at runtime and no documentation route; the documentation factory supplies
  no-op dependencies to register the complete `/v1` graph.
- Bad: maintaining a second handwritten path/schema list, registering Swagger
  UI on the tunneled listener, or documenting WebSocket payloads separately
  from the parser/sender schemas.

## 6. Tests Required

- Generate twice and assert deterministic serialization, OpenAPI `3.1.0`, the
  expected complete `/v1` path set, unique operation IDs, and `bearerAuth`.
- Assert generated JSON contains no `/admin/*`, `/_internal/*`, master/Claude
  key names, runtime-control credential, prompt, task output, or tool data.
- Validate representative WebSocket messages with the exported runtime Zod
  schemas and reject malformed subscriptions.
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
```

The route reuses its domain Zod schema, one generator builds the document, and
only the loopback application serves the UI.
