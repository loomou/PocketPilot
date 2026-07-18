# Add i18n to local admin configuration

## Goal

Add internationalization to PocketPilot's local administration interface so the operator can use Simplified Chinese or English without changing server-owned values or behavior.

## User Value

A local operator can understand and operate the configuration interface in either supported language while preserving the existing validated API, local-only security boundary, and explicit-save workflow.

## Confirmed Facts

- The local administration UI is the React/Vite workspace under `apps/local-admin`.
- The console currently uses hard-coded Simplified Chinese user-facing labels, with a small number of stable English error messages.
- The console has five local-state sections: Overview, Configuration, Devices, Audit, and Maintenance.
- The user confirmed that localization covers the complete local administration console, not only the Configuration section.
- The user approved persisted explicit language selection, browser-language detection on first visit, and Simplified Chinese fallback.
- The user requires a Pencil CLI prototype showing how language selection appears in the console before production source is changed.
- On July 18, 2026, the user approved the sidebar selector placement and visual direction.
- The initial release supports two locales, but the localization architecture must allow additional languages to be registered without rewriting feature components or locale-selection logic.
- There is no existing i18n dependency, locale context, browser-language detection, or locale persistence.
- Server-returned identifiers, URLs, operation names, command strings, and metadata values must remain unchanged.
- `App.tsx` must remain composition-only; feature behavior belongs under `src/features/administration` and reusable infrastructure belongs under `src/lib` or another focused source module.
- The application remains desktop-only and local-only. This feature must not add routes, backend settings, or remote API behavior.

## Requirements

### R1 - Supported languages and scope

- Support Simplified Chinese and English across the complete local administration console: shared shell/navigation, Overview, Configuration, Devices, Audit, Maintenance, notices, dialogs, empty states, validation text, and action labels.
- All localized UI text must come from typed or otherwise centrally owned translation resources rather than duplicated per-component conditionals.
- Supported locales and their display metadata must be defined through one extensible locale registry so adding another language does not require editing every consumer or introducing locale-specific branches.
- Switching language must not reload or discard the current configuration draft.
- Restore an explicit language choice from browser local storage; otherwise select Simplified Chinese for browser locales beginning with `zh`, English for other browser locales, and Simplified Chinese when browser language is unavailable.

### R2 - Design review gate

- Produce an editable Pencil prototype showing the language selector in representative Simplified Chinese and English console states.
- Do not modify production frontend source until the user reviews and approves the prototype direction.

### R3 - Contract preservation

- Preserve the current validated `/admin/*` API boundary, CSRF behavior, configuration save behavior, section navigation, and local-only constraints.
- Do not translate server-returned identifiers, URLs, audit operation names, command examples, or other opaque metadata.

### R4 - Accessibility and verification

- Language selection must have an accessible name and keyboard-operable native or established UI semantics.
- Tests must verify representative Chinese and English rendering and confirm configuration writes are unchanged.

## Prototype Artifacts

- Editable Pencil file: `prototype/local-admin-i18n.pen`
- Simplified Chinese overview preview: `prototype/png/01-chinese-overview.png`
- English configuration preview: `prototype/png/02-english-configuration.png`
- Proposed selector placement: bottom of the persistent sidebar, beneath the local-only access card.
- Approved control for the initial two-language release: compact segmented selector with `中文` and `English`; the active locale uses the primary dark fill.
- The implementation must keep selector options data-driven so the control can evolve to a scalable list/menu when more languages are registered.

## Acceptance Criteria

- [x] The complete local administration console can render in Simplified Chinese and English without mixed-language interface chrome.
- [x] The operator can switch language from the running interface without a page reload.
- [x] An editable Pencil prototype and PNG previews show the approved selector placement and both language states before implementation begins.
- [x] The initial locale follows persisted choice, then browser language, then Simplified Chinese fallback.
- [x] Switching language preserves the current section and any unsaved configuration edits.
- [x] Translation resources have one authoritative key set and missing keys fail during development or type checking rather than silently rendering raw keys.
- [x] A new locale can be added by registering locale metadata and a complete translation resource without rewriting feature components or locale detection/persistence logic.
- [x] Server-returned identifiers, URLs, audit operation names, command strings, and metadata values remain unchanged.
- [x] Existing configuration writes still send the validated runtime/task payloads with the CSRF token.
- [x] Automated tests cover both locales and language switching.
- [x] Local-admin and root lint, type-check, test, and production build checks pass.

## Out of Scope

- Backend locale negotiation or localized API error payloads.
- Additional languages beyond Simplified Chinese and English.
- Mobile or narrow-screen layout work.
- Translating user-entered values or server-owned opaque values.

