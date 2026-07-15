# Backend Directory Structure

## Layout

```text
src/
├── app.ts       # Unbound Fastify application composition
├── cli.ts       # Executable boundary and top-level exit handling
└── cli/
    ├── program.ts            # Commander command registration
    └── bootstrap-command.ts  # Explicit unavailable-runtime error
test/
├── app.test.ts
└── cli.test.ts
```

## Module Rules

- Keep network application composition in `src/app.ts`; it must not bind a
  listener. Listener ownership will live in the future process/runtime layer.
- Keep command parsing in `src/cli/`. `src/cli.ts` only creates the program,
  invokes it, and translates known command errors into exit codes.
- Add future domain layers below `src/` by ownership (`auth/`, `storage/`,
  `tasks/`, `remote-api/`, `local-admin/`) rather than by generic file type.
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
