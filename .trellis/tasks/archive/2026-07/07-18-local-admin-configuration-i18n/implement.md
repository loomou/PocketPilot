# Implementation Plan: Local Administration i18n

## Preconditions

- The Pencil prototype is approved.
- `prd.md` and `design.md` are reviewed.
- Production edits begin only after the user approves task activation and `task.py start` changes the task to `in_progress`.
- Leave unrelated `.claude/settings.local.json` untouched.

## Ordered Checklist

### 1. Create typed i18n infrastructure

- [x] Add the authoritative Simplified Chinese message resource.
- [x] Add the mapped translation schema that widens string leaves and preserves message-function signatures.
- [x] Add the complete English resource satisfying the schema.
- [x] Add the locale registry with IDs, native labels, Intl tags, browser match metadata, and resources.
- [x] Add pure locale-resolution helpers for persisted locale, browser matching, unknown-browser English fallback, and unavailable-browser Simplified Chinese fallback.
- [x] Add guarded local-storage read/write helpers with a namespaced key.
- [x] Add `I18nProvider`/`useI18n` and update `document.documentElement.lang`.

Validation checkpoint:

```powershell
pnpm --filter @pocketpilot/local-admin typecheck
```

### 2. Add the approved scalable locale selector

- [x] Add a locale switcher under `features/administration`.
- [x] Render the approved segmented control for the initial two registry entries.
- [x] Render a labeled native select automatically when the registry grows beyond two entries.
- [x] Add accessible labeling, selected state, keyboard-native semantics, and focus styling.
- [x] Place it beneath the local-only sidebar card without changing navigation or desktop layout.

### 3. Migrate shared administration chrome and stateful notices

- [x] Wrap `App` with the provider in `main.tsx`; keep `App.tsx` composition-only.
- [x] Replace shell/navigation/status/refresh/local-access strings with typed resource reads.
- [x] Make section metadata resolve labels/descriptions during render.
- [x] Change success notices from rendered strings to semantic notice codes.
- [x] Normalize known client errors to translatable codes while preserving opaque backend messages.
- [x] Translate loading, failure, badges, accessible names, and shared field labels.
- [x] Pass the current Intl tag into timestamp formatting.

State-preservation checkpoint:

- Navigate to Configuration.
- Change a draft value without saving.
- Switch locale.
- Confirm the Configuration section and edited value remain unchanged.

### 4. Migrate every console view

- [x] Overview: metrics, status, pairing summary, policy, audit summary, empty/loading text, and actions.
- [x] Configuration: headings, field labels/help, task settings, draft warning, reset/save actions, and validation text.
- [x] Devices: summaries, pairing forms, approval/revocation actions, dialogs, QR presentation, empty states, and timestamps.
- [x] Audit: headings, filters/columns, result labels, metadata labels, and empty state.
- [x] Maintenance: metadata labels, recovery guidance, numbered steps, warnings, and copy/action labels.
- [x] Re-scan all local-admin TSX files for remaining user-owned hard-coded Chinese or English chrome.
- [x] Confirm opaque identifiers, URLs, commands, device names, and audit operations remain raw.

### 5. Add and update tests

- [x] Clear local storage and restore globals after each test.
- [x] Add locale-resolution tests for persisted selection, `zh*`, non-`zh`, unavailable browser language, invalid persisted IDs, and storage failures.
- [x] Verify representative Simplified Chinese rendering.
- [x] Verify representative English rendering across shell and views.
- [x] Verify switching locale is immediate and updates `document.documentElement.lang` and persistence.
- [x] Verify switching while Configuration has an unsaved draft preserves section and input value.
- [x] Verify known notices re-render in the newly selected locale.
- [x] Preserve the configuration-write assertions for both PUT requests, CSRF header, JSON content type, and payload values.
- [x] Verify server-owned audit operations, URLs, commands, and names remain unchanged.
- [x] Verify locale selector accessibility and its registry-driven options.

Workspace validation:

```powershell
pnpm --filter @pocketpilot/local-admin lint
pnpm --filter @pocketpilot/local-admin typecheck
pnpm --filter @pocketpilot/local-admin test
pnpm --filter @pocketpilot/local-admin build
```

### 6. Full quality gate

- [x] Run the Trellis check workflow against frontend specs.
- [x] Fix all lint, type, test, build, accessibility, or spec-compliance findings.
- [x] Run root checks required by the frontend quality specification.

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [x] Review `git diff` and confirm no backend production contract or unrelated production file changed; only the documented root-test portability fix was added.
- [x] Update Trellis specs only if implementation establishes a reusable i18n convention that future work must follow.

## Risky Files and Rollback Points

- `administration-page.tsx`: notice-state migration and configuration draft preservation. Roll back this slice if mutations or transient state regress.
- `administration-shell.tsx`: persistent sidebar/layout and selector placement. Compare against Pencil previews after changes.
- `administration-ui.tsx`: shared status/result formatting used by multiple views. Validate recognized and unknown server values separately.
- Translation resources: a missed or semantically mismatched key affects many views; rely on schema and view-level tests.
- Tests: explicitly control locale state to avoid host-language-dependent failures.

## Review Gates

1. **Activation gate:** user approves `prd.md`, `design.md`, and `implement.md`; then run `task.py start`.
2. **Infrastructure gate:** typecheck passes after provider, registry, resources, and resolver are added.
3. **Migration gate:** no user-owned hard-coded interface chrome remains and the draft survives switching.
4. **Contract gate:** API write tests and opaque-value checks pass.
5. **Final gate:** local-admin and root lint/typecheck/test/build all pass before commit or archive.


## Validation Status (July 18, 2026)

- Local-admin lint, type-check, tests, and production build pass. Vitest reports
  2 files and 15 passing tests.
- Root lint, type-check, tests, and production build pass. Root Vitest reports
  29 passing files, 1 skipped file, 85 passing tests, and 1 skipped test.
- The Windows-only 8.3 path mismatch in
  `test/tasks/claude-session-manager.test.ts` was removed by canonicalizing the
  fixture workspace with `realpathSync.native`, matching production
  `node:fs/promises` realpath behavior without changing TaskManager code.
- `git diff --check` passes. Feature changes remain confined to local-admin
  frontend code, tests, Trellis task artifacts, and frontend specs. The only
  additional root changes are the documented test-fixture path normalization
  and its backend quality-guideline entry.
- The reusable locale registry/provider, locale-neutral notice/error boundary,
  opaque server-value rules, selector scaling behavior, and locale-aware
  timestamp/result formatting are recorded in
  `.trellis/spec/frontend/i18n-guidelines.md`.
- The Windows path assertion convention is recorded in
  `.trellis/spec/backend/quality-guidelines.md`.
