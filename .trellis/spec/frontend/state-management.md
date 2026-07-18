# State Management

## State Categories

- `LocalAdminSnapshot` is the current validated server snapshot: status,
  settings, authorized directories, pending pairings, devices, audits, and the
  runtime CSRF token.
- Form edits are local immutable updates to the configuration inside that
  snapshot and become server state only after Save succeeds.
- Authorized directories are immediate server state, not form state. Add,
  Remove, and stale-conflict refresh replace only
  `snapshot.authorizedDirectories`; they must not replace staged runtime or
  capacity values.
- Busy action, notice, approval-code inputs, and the generated QR image are
  transient UI state. They are not persisted or promoted to a global store.

## Server State

The local page has one feature and one server, so React state plus explicit
refresh is sufficient. Add a caching library only when invalidation,
background synchronization, or multiple page consumers create demonstrated
complexity.

After a mutation, keep the successful result/notice and refresh the collections
that another device or the Agent may have changed. Never treat browser state as
the authority for device revocation or pending-pairing status.

Phone registration is asynchronous relative to QR generation. While the
current QR is valid, replace only `snapshot.pendingPairings` from the typed
pending endpoint. A failed poll leaves all state unchanged; a newer QR or
unmount aborts the old poll. This follows the same partial-snapshot rule as
authorized-directory refresh and preserves unsaved configuration values.

For directory mutations, the returned snapshot is authoritative. On a stale
removal response, refresh only `/admin/authorized-directories` and require the
user to confirm the new revision/count; never auto-retry a P0 removal.

## Common Mistakes

- Do not store the CSRF token in local storage; keep it in the in-memory runtime
  snapshot.
- Do not persist the QR or pairing payload in browser storage.
- Do not create a global store for form fields that have one page owner.
- Do not call the full-page `refresh()` after Add/Remove; it overwrites unsaved
  form edits with persisted configuration.
