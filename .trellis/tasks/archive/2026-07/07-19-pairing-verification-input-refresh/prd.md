# Pairing Approval Input Refresh

## Goal

Show the pending device and its six-digit approval input automatically after a
phone scans and registers a generated pairing QR. The operator must not need to
press Generate QR a second time or manually refresh the page.

## Background

- `AdministrationPage` loads the complete local-admin snapshot once on mount
  and exposes a manual refresh action (`administration-page.tsx:49`).
- `generatePairing` creates and renders the QR, then immediately calls the full
  snapshot refresh once (`administration-page.tsx:91` and `:107`).
- Phone registration normally happens after that one refresh. The server then
  exposes the row through `GET /admin/pairings/pending`, but the page performs
  no later read, so the Pending approvals UI at
  `administration-page.tsx:481` remains empty.
- Pressing Generate QR again happens to run another full refresh and reveals
  the already-registered device. The second QR is not semantically required.
- Polling the complete snapshot would overwrite staged runtime/task form edits,
  so the refresh must be scoped to pending pairings only.

## Requirements

1. Export a typed `loadPendingPairings()` client function for the existing
   `GET /admin/pairings/pending` endpoint and reuse the existing Zod schema.
2. After a QR is successfully generated, poll pending pairings approximately
   once per second until that QR expires, a newer QR replaces it, or the page
   unmounts.
3. Poll serially with a self-scheduled timeout so a slow request cannot overlap
   the next request.
4. Merge each successful result into only `snapshot.pendingPairings`. Preserve
   staged configuration, authorized-directory state, devices, audits, notices,
   approval-code input, and the displayed QR.
5. A transient polling failure keeps the current UI and retries on the next
   interval; it must not replace the successful QR notice or clear the form.
6. Keep the existing approval action and backend pairing/authentication
   contracts unchanged.

## Acceptance Criteria

- [x] Starting with no pending pairings, one Generate QR click renders the QR;
      when the mocked phone registration later appears from the pending endpoint,
      the device row and Mobile code input appear without another click.
- [x] The polling update does not reset an unsaved runtime/task form edit.
- [x] Polling stops after QR expiry, when a new QR supersedes the old one, and
      when the component unmounts; requests never overlap.
- [x] A failed poll preserves the QR, notice, and current snapshot and later
      polling can recover.
- [x] Existing local-admin tests, type-check, lint, and production build pass.

## Out of Scope

- Adding a WebSocket or server-sent event for local pairing administration.
- Changing QR lifetime, registration, verification-code, approval, or claim
  behavior.
- Polling the full local-admin snapshot or changing the mobile client.

