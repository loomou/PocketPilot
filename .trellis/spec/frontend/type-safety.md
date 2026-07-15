# Frontend Type Safety

## Compiler Contract

`apps/local-admin/tsconfig.json` uses strict TypeScript, checked indexed access,
exact optional properties, and the `@/*` source alias. Keep those options when
adding feature-level configuration.

## Component Types

- Derive native control props from React DOM prop types, as `ButtonProps` does
  with `ButtonHTMLAttributes<HTMLButtonElement>`.
- Derive variant props from `class-variance-authority` rather than duplicating
  string unions.
- Use `as const` for fixed display data. Introduce a named interface only when
  dynamic configuration data or multiple consumers need it.

## Runtime Data Boundary

There is no local API client yet. When configuration data is introduced, decode
unknown HTTP data at the client boundary with a shared Zod schema; components
must not cast JSON with `as` or use `any`.
