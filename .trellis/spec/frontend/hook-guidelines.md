# Hook Guidelines

## Current Pattern

- `AdministrationPage` loads one typed server snapshot from a memoized
  `useCallback` in `useEffect`.
- Keep network decoding out of effects and event handlers. Hooks call functions
  from `src/api/local-admin.ts` and receive validated values or typed errors.
- Mutation handlers set one action identifier, use `try/catch/finally`, and
  update only the returned server-owned collection after success when a full
  snapshot refresh would overwrite staged form edits.
- QR generation sets the active server-returned pairing identity and clears the
  local approval code. No effect or input handler performs network I/O for the
  approval flow.
- Do not create a custom hook until stateful logic has a second real consumer
  or extracting it materially simplifies the feature.

## Data Fetching

Initial independent GET requests run in parallel. Configuration mutations stay
explicit and ordered so the page can identify a partial failure. Pairing
approval sends one explicit request only after the operator clicks Approve and
uses the returned device to update local server state; it does not justify a
background synchronization mechanism.

## Common Mistakes

- Do not put raw `fetch` or response casts in a component hook.
- Do not clear a successful action notice during the follow-up refresh.
- Do not let an unmounted or missing snapshot trigger a mutation; actions stay
  disabled until initial data and the CSRF token exist.
- Do not call the approval API from QR generation, code input, or input blur;
  only the explicit Approve action may submit the code.
