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

## Application Boundary

Keep API calls in `src/api`, stateful local administration behavior in the
named feature, and `App.tsx` as composition only. The page must not add task
controls, process start/stop actions, Claude configuration, or credential
inputs.

## Authorized Directories

- Render authorization as its own unframed security section, separate from the
  Runtime and task policy form.
- Use a folder-plus Add command and per-row trash Remove command. Long canonical
  paths use `break-all`; unavailable roots stay visible and removable.
- Show affected open-session counts and whole-volume status next to each path.
  Native `window.confirm` is the explicit P0/high-risk gate in this MVP.
- Disable competing actions while a picker/add/removal is in flight, but do not
  stage directory mutations behind Save configuration.
