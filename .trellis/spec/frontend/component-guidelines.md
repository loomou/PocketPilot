# Component Guidelines

## Composition

- Export named React components. `App` is the root composition component;
  reusable primitives export their component and any variant helper explicitly.
- Use a typed `asChild` option and Radix `Slot` only in shared primitives where
  composition is required. See `src/components/ui/button.tsx`.
- Keep page-level display lists as immutable `as const` data when they contain
  no user or server state.

## Styling

- Use Tailwind utilities in JSX and Tailwind v4 from `src/styles.css`.
- Use `cn()` from `@/lib/utils` to merge conditional utility classes. Do not
  concatenate class strings by hand.
- New shadcn components must respect `components.json` aliases and remain
  framework-neutral; application-specific behavior belongs outside `ui/`.

## Accessibility

- Native buttons must specify their type when rendered in a form-capable
  context.
- Icons that do not add text meaning use `aria-hidden="true"`.
- Disabled scaffold actions must be visibly disabled and use the native
  `disabled` attribute; do not simulate disabled behavior with a click guard.

## Current Boundary

The scaffold presents placeholders only. Components must not add fetch calls,
task controls, Claude configuration, or persistent client state until the
localhost-only API contract exists.
