# Hook Guidelines

## Current Pattern

- `AdministrationPage` loads one typed server snapshot from a memoized
  `useCallback` in `useEffect`.
- Keep network decoding out of effects and event handlers. Hooks call functions
  from `src/api/local-admin.ts` and receive validated values or typed errors.
- Mutation handlers set one action identifier, use `try/catch/finally`, and
  refresh server-owned collections after success.
- Do not create a custom hook until stateful logic has a second real consumer
  or extracting it materially simplifies the feature.

## Data Fetching

Initial independent GET requests run in parallel. Configuration mutations stay
explicit and ordered so the page can identify a partial failure. Pairing,
device, and audit changes use an explicit refresh; there is no background
poller or remote server-state library.

## Common Mistakes

- Do not put raw `fetch` or response casts in a component hook.
- Do not clear a successful action notice during the follow-up refresh.
- Do not let an unmounted or missing snapshot trigger a mutation; actions stay
  disabled until initial data and the CSRF token exist.
