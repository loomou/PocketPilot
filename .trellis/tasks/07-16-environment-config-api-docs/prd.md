# Environment Configuration and API Documentation

## Goal

Make PocketPilot settings that cannot safely or practically be changed from
the localhost administration page configurable through a dotenv-backed startup
file, and provide generated API documentation that stays aligned with the
validated Fastify contracts used by mobile-client integrations.

## Confirmed Facts

- The localhost administration page currently manages the mobile base URL,
  remote listener host/port, authorized workspace roots, and concurrent-task
  capacity.
- Production code currently reads `AGENT_MASTER_KEY`,
  `AGENT_NEW_MASTER_KEY`, and `POCKETPILOT_DATA_DIR` from the process
  environment. `CLAUDE_SDK_LIVE` is test-only.
- The local-admin port is fixed to `43183` in production; only tests can
  override it through an internal `AgentRuntime` option.
- Claude credentials and Claude configuration remain owned by the Claude Agent
  SDK. PocketPilot must not add an API-key field to its local page, database,
  logs, or API documentation examples.
- Remote mobile routes and localhost administration routes run on separate
  Fastify instances. Local administration and internal shutdown routes must
  never be exposed through the remote listener.
- HTTP request and response contracts already use Zod through the Fastify Zod
  type provider. This is the authoritative source from which generated API
  schemas should be derived.
- The remote integration also includes the `/v1/events` WebSocket protocol,
  which OpenAPI alone does not describe completely.
- No relevant dotenv/OpenAPI decision was found in prior indexed sessions; the
  existing code, archived task artifacts, and project specs are authoritative.

## Requirements

- Add dotenv-based loading for an explicitly defined set of bootstrap/runtime
  settings that are intentionally unavailable from the localhost page.
- The supported dotenv allowlist is `AGENT_MASTER_KEY`,
  `AGENT_NEW_MASTER_KEY`, `POCKETPILOT_DATA_DIR`, and
  `POCKETPILOT_LOCAL_ADMIN_PORT`. The rekey-only new key remains optional and
  must be removed after rotation.
- Define deterministic precedence between an existing process environment and
  values loaded from a dotenv file: an explicitly supplied process-environment
  value wins over the file.
- Load only the exact `.env` file in the process startup working directory.
  Do not search parent directories or infer a file from the configured Agent
  data directory. Absence of that file is allowed when required values are
  supplied by the process environment.
- Validate every supported dotenv value through a typed boundary before it is
  used; malformed security or listener settings must fail before listeners
  bind.
- Do not load arbitrary dotenv keys into PocketPilot-owned configuration or
  weaken the Claude SDK credential/configuration boundary. In particular,
  PocketPilot does not parse or deliberately forward `ANTHROPIC_*` or other
  Claude credential/configuration keys from this file.
- Provide a safe `.env.example` and update Windows installation/operation
  documentation without committing real secrets.
- Generate API documentation from the existing validated route schemas rather
  than maintaining a second hand-written REST contract.
- Generate one integration contract for the remote mobile `/v1` API only.
  Localhost `/admin/*`, `/_internal/*`, and other local implementation routes
  must be absent; `/healthz` may be mentioned separately as an operational
  probe but is not part of the versioned mobile contract.
- Serve Swagger UI from the localhost administration listener at
  `/documentation`, backed by the remote mobile contract. Do not register
  documentation routes on the remote listener.
- Emit the same generated contract as `dist/openapi/mobile-v1.json` during the
  production build so it can be shared or consumed by client generators
  without access to the running Agent.
- Document authentication, stable error bodies, pairing/task operations, and
  the event-stream integration needed by the mobile client.
- Use one OpenAPI 3.1 document. Describe `/v1/events` through an
  `x-websocket` vendor extension whose inbound/outbound message JSON Schemas
  are generated from the same exported Zod schemas used by the runtime. A
  separate AsyncAPI document is not required.
- Add automated checks that fail when documented routes or schemas drift from
  the executable contracts.

## Acceptance Criteria

- [ ] A supported dotenv file can supply every approved non-page bootstrap
      setting on Windows, and explicitly supplied process-environment values
      take the documented precedence.
- [ ] Starting the Agent from different working directories loads only that
      directory's `.env`; PocketPilot performs no parent-directory discovery.
- [ ] `POCKETPILOT_LOCAL_ADMIN_PORT` accepts only an available integer TCP port
      from `1` through `65535` and remains loopback-only.
- [ ] Missing or invalid required security configuration fails before SQLite
      or either listener is exposed, with no secret value written to logs.
- [ ] The localhost page continues to own its existing four configuration
      areas and does not gain master-key or Claude-credential inputs.
- [ ] The repository contains a secret-free `.env.example` and documentation
      explaining file location, precedence, rotation, and reset behavior.
- [ ] A generated OpenAPI document covers the selected remote HTTP API surface
      from the Zod/Fastify schemas and includes authentication plus stable error
      contracts.
- [ ] The localhost listener serves Swagger UI and its raw OpenAPI document,
      while the remote listener returns 404 for documentation routes.
- [ ] `pnpm build` emits `dist/openapi/mobile-v1.json`, and the packaged
      tarball includes the same current document.
- [ ] Local administration and `/_internal/*` routes are absent from the remote
      integration document.
- [ ] The `/v1/events` WebSocket handshake and message protocol are documented
      through `x-websocket`, including Bearer authentication, subscribe,
      subscribed/event/error messages, close codes, and cursor-based reconnect
      semantics.
- [ ] Tests cover dotenv precedence/validation, secret redaction, generated
      schema availability, route isolation, and packaged documentation assets.
- [ ] Lint, type-check, tests, production build, and the Windows packed-release
      smoke test pass.

## Out of Scope

- Adding Claude API-key or Claude configuration management to PocketPilot.
- Making the localhost administration listener remotely reachable.
- Replacing the existing Fastify/Zod route contracts with a separate API-first
  framework.
- Publishing documentation to a hosted public service in this task.
