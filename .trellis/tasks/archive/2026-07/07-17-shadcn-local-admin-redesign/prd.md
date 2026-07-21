# Redesign local admin with shadcn UI

## Goal

Redesign PocketPilot's local-only administration surface into a clearer operational console using Tailwind CSS and shadcn/ui patterns. Validate the information architecture and visual direction with a Pencil design prototype before changing production React code.

## Approved direction

- On 2026-07-17, the user approved the left-sidebar operational-console direction as the formal implementation baseline.
- Mobile and narrow-screen layouts are explicitly excluded; the approved implementation targets the desktop local-admin console only.
- Production interface copy follows the approved Pencil prototype's Simplified Chinese labels while retaining server-returned identifiers and metadata values unchanged.

## User value

The local operator should be able to understand Agent health, change runtime and task policy, pair or revoke mobile devices, inspect security metadata, and find terminal-only maintenance guidance without scanning one long undifferentiated page.

## Confirmed facts

- The production UI is the isolated `apps/local-admin` React 19/Vite workspace.
- Tailwind CSS 4.3.2 is already integrated through `@tailwindcss/vite`.
- shadcn configuration already uses the `new-york` style, slate base color, Lucide icons, and `@/components/ui` aliases.
- The production UI currently has one shadcn-style `Button` primitive and one stateful `AdministrationPage`.
- The browser API exposes Agent status, runtime settings, task settings, pairing creation/approval, device revocation, and audit records.
- The page must remain local-only. It must not become a mobile task-control surface, start or stop the Agent, or manage Claude credentials.
- Pencil CLI is installed locally and authenticated. The prototype will be stored as a `.pen` planning artifact in this task directory.

## Requirements

### R1 — Pencil prototype before production implementation

- Produce one editable Pencil design file at `prototype/local-admin-redesign.pen`.
- Export a PNG preview at `prototype/local-admin-redesign-preview.png` for quick review and task history.
- Keep the design artifact outside `apps/local-admin` and disconnected from the production build.
- Use representative static content only; the design must not imply live API integration.

### R2 — Information architecture

- Use a desktop-only console shell with a left navigation rail and a focused content workspace.
- Provide designed states for Overview, Configuration, Devices, Audit records, and Maintenance.
- Preserve every capability already supported by the production local-admin contract.
- Keep terminal-only key maintenance visibly separated from browser actions.

### R3 — Visual direction

- Follow shadcn/ui `new-york` conventions: compact controls, slate neutrals, restrained borders, small radius, clear typography, and Lucide-like line icons.
- Use emerald only for healthy/success state, amber for pending/warnings, and red for destructive/revoked state.
- Prefer cards and tables over decorative dashboard graphics.
- Limit the approved prototype and production direction to desktop frames; no mobile or narrow-screen state is required.

### R4 — Required designed states

- Overview with health, endpoints, policy summary, pending pairing, and recent audit activity.
- Configuration with runtime/task settings and a visible unsaved-change save bar.
- Devices with QR pairing dialog, pending approval, paired inventory, and revoke confirmation.
- Audit records with search, result filter, populated table, and empty-result state.
- Maintenance with security metadata and terminal-only rekey/reset guidance.
- Toast/status feedback in representative desktop action states.

### R5 — Production implementation gate

- Do not edit formal frontend source under `apps/local-admin` until the user reviews and approves the Pencil direction.
- After approval, revise this plan if needed, then activate the task before production implementation.

## Acceptance criteria

- [x] `prototype/local-admin-redesign.pen` exists and opens in Pencil.
- [x] A PNG preview is exported beside the Pencil file.
- [x] The design covers Overview, Configuration, Devices, Audit records, and Maintenance.
- [x] Required dialog, warning, empty, dirty, and toast states are represented in desktop frames.
- [x] All current local-admin capabilities are represented without adding task controls, Agent start/stop, or Claude credential management.
- [x] No files under `apps/local-admin` are changed during the prototype phase.
- [x] The user reviewed the Pencil prototype and approved the desktop left-sidebar operational-console direction on 2026-07-17.

## Out of scope for the prototype phase

- Mobile and narrow-screen layouts or navigation states.

- Real API requests or persistence.
- Production React components and tests.
- Adding new backend endpoints or settings.
- Mobile task execution controls.
- Agent process start/stop controls.
- Claude account, model, prompt, or credential configuration.
