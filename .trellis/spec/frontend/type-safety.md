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

`src/api/local-admin.ts` decodes unknown HTTP data with Zod and exports inferred
types. Components must not cast JSON with `as`, duplicate response interfaces,
or use `any`. API errors also pass through a validated `{ code, message }`
schema before their message reaches the page.

The same module owns the discriminated picker response and directory snapshot,
add, and remove schemas. Keep `selectionId` as UUID, `revision`/counts as
non-negative integers, paths bounded to 4096 characters, and directory status
as `"available" | "unavailable"`. Components consume inferred
`AuthorizedDirectory`/snapshot types and never decode these payloads locally.
