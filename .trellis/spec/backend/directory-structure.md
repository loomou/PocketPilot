# Backend Directory Structure

## Layout

```text
src/
├── app.ts       # Unbound Fastify application composition
├── api-docs/                  # Mobile OpenAPI factory and build entry
├── auth/                     # Pairing, device proof, credentials, revocation
├── cli.ts       # Executable boundary and top-level exit handling
├── cli/
│   └── program.ts            # Commander command registration and dispatch
├── config/                    # Allowlisted dotenv loading and typed readers
├── http/                     # Shared unbound Fastify setup and health route
├── local-admin/              # Local-only app factory and CSRF guard
├── remote-api/               # Remote-only HTTP/WebSocket application factory
├── runtime/                  # Listener ownership, data lock, stop, maintenance
├── storage/                  # SQLite, encryption, and settings persistence
└── tasks/                    # Persistent task state, SDK lifecycle, policy
test/
├── app.test.ts
└── cli.test.ts
```

## Module Rules

- Keep network application composition in `src/app.ts`; it must not bind a
  listener. `src/runtime/` owns listener binding and process lifecycle.
- Keep command parsing in `src/cli/`. `src/cli.ts` only creates the program,
  invokes it, and translates known command errors into exit codes.
- Keep bootstrap file loading, environment allowlists, and typed environment
  readers in `src/config/`; command/runtime modules consume the validated
  snapshot instead of reading dotenv independently.
- Keep reusable OpenAPI composition and its side-effect-free build entry in
  `src/api-docs/`. Route modules continue to own executable Zod schemas.
- Add future domain layers below `src/` by ownership (`auth/`, `storage/`,
  `tasks/`, `remote-api/`, `local-admin/`) rather than by generic file type.
- Keep listener binding, runtime-control state, signal handling, and foreground
  lifecycle in `src/runtime/`; route factories must remain unbound.
- Keep the shared Agent data lock and stopped-only CLI maintenance orchestration
  in `src/runtime/`; storage primitives must not infer process ownership.
- Keep shared HTTP compiler/plugin setup in `src/http/`, not copied into the
  remote and local-admin factories.
- Keep persistent task policy, state transitions, SDK lifecycle ownership, and
  task metadata repositories in `src/tasks/`; HTTP routes only validate and
  translate the control contract.
- Keep each test beside its observable boundary under `test/` until a module
  becomes large enough to need its own test directory.

## Naming

- Use lowercase kebab-case filenames and directory names.
- Use `create*` for configured factories such as `createProgram` and `build*`
  for dependency-owning application composition such as `buildApp`.
- Import local ESM modules with their emitted `.js` extension.

## References

- Application composition: `src/app.ts`
- CLI command registration: `src/cli/program.ts`
