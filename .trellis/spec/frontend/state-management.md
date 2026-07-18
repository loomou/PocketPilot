# State Management

## State Categories

- `LocalAdminSnapshot` is the current validated server snapshot: status,
  settings, authorized directories, devices, audits, and the runtime CSRF token.
- Form edits are local immutable updates to the configuration inside that
  snapshot and become server state only after Save succeeds.
- Authorized directories are immediate server state, not form state. Add,
  Remove, and stale-conflict refresh replace only
  `snapshot.authorizedDirectories`; they must not replace staged runtime or
  capacity values.
- Busy action, notice, the active pairing identity, approval-code input, and the
  generated QR image are transient UI state. They are not persisted or promoted
  to a global store.

## Server State

The local page has one feature and one server, so React state plus explicit
refresh is sufficient. Add a caching library only when invalidation,
background synchronization, or multiple page consumers create demonstrated
complexity.

After a mutation, keep the successful result/notice and update only the
server-owned collection represented by the validated response when a full
snapshot refresh would overwrite staged form edits. Pairing approval appends
the returned device, clears the active QR/code, and leaves configuration edits
untouched.

For directory mutations, the returned snapshot is authoritative. On a stale
removal response, refresh only `/admin/authorized-directories` and require the
user to confirm the new revision/count; never auto-retry a P0 removal.

## Common Mistakes

- Do not store the CSRF token in local storage; keep it in the in-memory runtime
  snapshot.
- Do not persist the QR or pairing payload in browser storage.
- Do not make the pending-pairing list a prerequisite for approval; the active
  QR already supplies the pairing ID and the user supplies the mobile code.
- Do not create a global store for form fields that have one page owner.
- Do not call the full-page `refresh()` after Add/Remove; it overwrites unsaved
  form edits with persisted configuration.
