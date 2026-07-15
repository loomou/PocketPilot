# Frontend Directory Structure

## Workspace Boundary

The local configuration UI is the isolated pnpm workspace package
`apps/local-admin`. It is not served by the remote mobile API and has no import
path into the Node Agent source.

```text
apps/local-admin/
├── components.json     # shadcn registry and alias configuration
├── src/
│   ├── App.tsx         # Root composition only
│   ├── api/            # Zod-decoded localhost API boundary
│   ├── main.tsx        # React mount boundary
│   ├── styles.css      # Tailwind entry stylesheet
│   ├── components/ui/  # Reusable shadcn-style primitives
│   ├── features/       # Stateful administration features
│   └── lib/            # UI-only utilities
└── test/               # Component-level Vitest tests
```

## Module Rules

- Keep `App.tsx` as composition only. Functional configuration state and
  behavior belong in `features/administration`.
- Keep HTTP paths, Zod response schemas, error translation, and CSRF write
  helpers in `api/local-admin.ts`; components consume typed results only.
- Place shadcn-derived primitives under `src/components/ui/`; keep application
  components out of that directory.
- Keep browser-only values and local API clients out of `main.tsx`. The mount
  module should only create the React root and load global styles.
- Use the `@/` alias for imports under `src/`.

## References

- Vite and alias setup: `apps/local-admin/vite.config.ts`
- Current root UI: `apps/local-admin/src/App.tsx`
- shadcn configuration: `apps/local-admin/components.json`
