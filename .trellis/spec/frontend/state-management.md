# State Management

## 1. Scope / Trigger

Apply this contract when adding or changing local-admin configuration drafts,
workspace authorization inspection, directory-browser modal state, mutation
reconciliation, or locale-preserving UI state.

## 2. State Categories

- `LocalAdminSnapshot` is the current validated server snapshot: status,
  settings, pending pairings, devices, audits, and the runtime CSRF token.
- `configurationDraft.tasks.workspaceRoots` is the only editable root list. It
  is local immutable state and becomes server state only after Save succeeds.
- `confirmedHighRiskRoots` is transient confirmation state keyed by the draft
  paths; it is sent write-only with Save and is never persisted or displayed as
  server settings.
- Directory listing, address, selected tab, modal open state, inspection data,
  busy action, notices, approval-code inputs, and generated QR image are
  transient UI state. They are not persisted or promoted to a global store.

## 3. Server State

The local page has one feature and one server, so React state plus explicit
refresh is sufficient. Add a caching library only when invalidation,
background synchronization, or multiple page consumers create demonstrated
complexity.

After a mutation, replace the typed configuration snapshot with the validated
response and refresh collections that another device or the Agent may have
changed. Never treat browser state as the authority for directory availability,
device revocation, or pending-pairing status.

## 4. Contracts

- General and Authorized directories tabs share one form and Save/Discard bar.
  Add/remove actions update only the draft, and Discard restores the snapshot
  plus clears confirmations and transient inspection state.
- Successful Save reconciles the draft to the returned canonical settings and
  clears only confirmations that were submitted. Failed Save preserves the
  draft so the user can correct it.
- Removing a draft root also removes its matching high-risk confirmation; do not
  leave confirmation state for a path that will no longer be submitted.
- Locale changes must rerender notices and labels without remounting the owning
  page or clearing tab, modal, address, listing, draft, or confirmation state.

## 5. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Initial snapshot load fails | Keep the shell visible and show a notice; do not invent settings. |
| Browse/inspect decode fails | Keep draft and listing state unchanged; show invalid-response notice. |
| Save succeeds | Replace server snapshot with validated response and reconcile draft. |
| Save fails validation/policy | Keep draft, clear no unrelated state, and show safe localized error. |
| Discard is requested | Restore snapshot roots and clear draft-only metadata. |
| Locale changes during modal/listing | Preserve all stateful controls and transient data. |

## 6. Tests Required

- Assert initial load/error behavior, local draft add/remove, duplicate and
  high-risk confirmation cleanup, Save/Discard, successful canonical response
  reconciliation, and failed-save draft preservation.
- Assert browse/inspect data is transient, CSRF is not stored in local storage,
  and locale switching preserves active tab/modal/address/listing/draft state.
- Assert unknown backend paths and messages remain opaque while known client
  notices are resolved from the active locale.

## 7. Wrong vs Correct

### Wrong

```tsx
setConfiguration(serverSnapshotWithDraftRoots);
setConfirmedHighRiskRoots(serverSnapshotWithDraftRoots.workspaceRoots);
return <AdministrationPage key={locale} />;
```

This promotes unsaved data to server state, treats confirmation as persisted
configuration, and remounts away all interaction state on locale changes.

### Correct

```tsx
setDraft((draft) => updateDraftRoots(draft, nextRoots));
setConfirmedHighRiskRoots((roots) => roots.filter(isStillDraftRoot));
// Keep AdministrationPage mounted while I18nProvider changes context.
```

The snapshot remains server-owned, draft/confirmation state remains local, and
locale changes only rerender the existing stateful tree.

## Common Mistakes

- Do not store the CSRF token in local storage; keep it in the in-memory runtime
  snapshot.
- Do not persist the QR, pairing payload, directory listing, or confirmation
  paths in browser storage.
- Do not create a global store for form fields or modal state that has one page
  owner.
