# Design: shadcn local-admin redesign

## Boundary

The prototype is an editable Pencil planning asset at `prototype/local-admin-redesign.pen`, with a PNG preview stored beside it. It remains outside `apps/local-admin`, is not referenced by package scripts, and uses representative static content. The user approved the desktop design direction on 2026-07-17; mobile and narrow-screen layouts are excluded from the implementation baseline.

## Pencil canvas structure

Create clearly named top-level frames so review and later implementation mapping remain explicit:

1. `Desktop / Overview`
2. `Desktop / Configuration / Dirty`
3. `Desktop / Devices`
4. `Desktop / Devices / Pair QR Dialog`
5. `Desktop / Devices / Revoke Confirmation`
6. `Desktop / Audit`
7. `Desktop / Audit / Empty`
8. `Desktop / Maintenance`

## Information architecture

### Application shell

- Persistent desktop-only sidebar with PocketPilot identity, local-only context, navigation, and live status.
- Page header owns the current section title, description, and contextual actions.

### Views

1. **Overview** — health summary, listener endpoints, policy summary, pending pairing, and recent audit activity.
2. **Configuration** — runtime endpoint settings and task policy in separate cards with one explicit save bar.
3. **Devices** — pairing entry point, pending approvals, and paired/revoked device inventory.
4. **Audit records** — searchable/filterable metadata table and empty state.
5. **Maintenance** — terminal-only rekey/reset guidance with destructive operations visually isolated.

## Visual system

- shadcn/ui `new-york` density and component proportions.
- Slate page background and surfaces, near-black primary action, small radii, thin borders, and restrained shadow.
- Typography hierarchy follows operational importance rather than marketing emphasis.
- Emerald, amber, and red are reserved for semantic state.
- Use consistent line icons and compact table/card spacing.
- Use reusable Pencil components or repeated visual patterns for navigation, buttons, badges, fields, cards, and table rows where practical.

## Prototype state model

The Pencil file expresses interactions as adjacent named states rather than executable application behavior:

- Configuration dirty state shows the sticky save/discard bar.
- Pairing state shows QR, pairing code, expiry, and static-data notice.
- Approval state shows the pending request and paired device result.
- Revoke state shows destructive confirmation and revoked inventory styling.
- Audit includes populated and no-result states.
- Toast/status feedback appears in representative action frames.

## Production mapping after approval

- Keep `App.tsx` composition-only.
- Split the existing `AdministrationPage` into feature-owned view components under `features/administration`.
- Add only the shadcn primitives actually used by the approved design under `components/ui`.
- Preserve `src/api/local-admin.ts` as the only decoded HTTP boundary and preserve the current React state/explicit refresh approach.
- Retain accessible names relied on by existing tests where user behavior is unchanged, updating tests only when the approved information architecture changes observable structure.

## Compatibility and rollback

- The `.pen` file and PNG export are planning artifacts only and have no runtime dependency.
- Production implementation must preserve the existing backend contract and `dist/local-admin` output path.
- The Pencil prototype remains a stable visual reference while production React changes can be reverted independently.