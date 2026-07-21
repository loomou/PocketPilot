# Technical Design: Local Administration i18n

## Summary

Introduce a small, typed client-side internationalization layer for `apps/local-admin`. The layer owns locale registration, initial locale resolution, persistence, document language metadata, translation resources, and locale-aware formatting. Administration components consume the current message resource through React context. The validated `/admin/*` API and all server-owned values remain unchanged.

The initial registry contains `zh-CN` and `en`. Its contracts are intentionally data-driven so an additional locale is added by supplying one complete message resource plus registry metadata, without adding language branches throughout the administration views.

## Design Goals

- Translate all user-owned console chrome in both initial locales.
- Preserve the active section, unsaved configuration draft, transient form inputs, and loaded server snapshot when locale changes.
- Make missing translation fields a TypeScript error.
- Keep locale detection and persistence independent from administration feature state.
- Keep identifiers, URLs, commands, audit operation names, and opaque backend messages unchanged.
- Preserve the approved two-language segmented selector while providing a scalable path when the registry grows.

## Non-Goals

- Backend locale negotiation or localized API responses.
- Runtime download of translation bundles.
- Route-based locales.
- ICU message parsing or a general translation-management platform.
- Adding a third locale in this task.

## Architecture

### 1. Typed translation resources

Add `apps/local-admin/src/lib/i18n/` with focused modules:

- `messages/zh-cn.ts`: authoritative Simplified Chinese resource.
- `messages/en.ts`: complete English resource.
- `message-schema.ts`: derives the required structural shape from the authoritative resource while widening string leaves and preserving formatter-function signatures.
- `locale-registry.ts`: locale metadata and the registered resource map.
- `locale-resolution.ts`: pure persistence/browser resolution helpers.
- `i18n-context.tsx`: React provider and hook.

Messages are nested by stable UI domain rather than by component filename, for example `shell`, `common`, `configuration`, `devices`, `audit`, `maintenance`, `notices`, and `errors`. Dynamic grammar uses typed message functions instead of concatenating translated fragments in components.

The Simplified Chinese resource defines the authoritative key shape. Every additional resource must satisfy a mapped `TranslationMessages` type. A missing field, wrong nesting shape, or incompatible formatter signature therefore fails `tsc`.

### 2. Extensible locale registry

The registry is the only source of supported locale metadata. Each entry contains:

- stable locale ID
- native display label
- HTML/Intl language tag
- browser language match prefixes/tags
- complete translation resource

`LocaleId` is derived from the registry keys. Components iterate exported locale definitions and do not compare against hard-coded locale IDs.

Initial policy:

1. Use a valid persisted registry ID.
2. Otherwise match the browser language against registered locale metadata.
3. If a browser language exists but no registered locale matches, use English.
4. If browser language is unavailable, use Simplified Chinese.

When a future locale is registered with matching browser tags, step 2 selects it automatically; the unknown-browser and unavailable-browser fallbacks remain explicit constants.

### 3. Provider placement and state preservation

`main.tsx` wraps `<App />` with `I18nProvider`. `App.tsx` remains composition-only.

The provider owns only:

- current locale ID
- locale change callback
- current messages and locale metadata

`AdministrationPage` remains mounted when locale changes. Its section, configuration draft, approval codes, pairing presentation, busy action, snapshot, and notice state therefore survive the context update.

On initialization and explicit changes, the provider updates `document.documentElement.lang`. Explicit changes are persisted under a namespaced local-storage key. Storage reads/writes are guarded so privacy settings or unavailable storage do not prevent the console from rendering.

### 4. Language selector behavior

Add `features/administration/locale-switcher.tsx` and place it beneath the local-only access card in the persistent sidebar, matching the approved Pencil prototype.

- With two registered locales, render the approved compact segmented buttons.
- If the registry later contains more than two locales, render a labeled native select automatically from the same metadata.
- Both variants expose an accessible group/label, current selection, keyboard operation, and native button/select semantics.
- Native locale labels come from registry metadata and are not duplicated in translation resources.

This adaptive behavior preserves the approved initial visual treatment without making a third language overflow the fixed-width sidebar.

### 5. Translation consumption

Administration shell and all five views call `useI18n()` and read the current typed message tree. Static module-level Chinese display tables become locale-independent structures containing only IDs/icons, with labels resolved during render.

All user-owned text moves to resources, including:

- navigation and headings
- field labels, descriptions, buttons, dialogs, empty states, notices, validation/help text
- accessible names and visually hidden descriptions
- client-generated loading/error/status labels

The following values remain raw:

- host/port strings and URLs
- device names and IDs
- verification codes and tokens
- audit operation names and task IDs
- shell commands and filesystem paths
- unknown backend-provided error messages

### 6. Notices and errors

A notice must not store already-translated success text, because that text would remain in the previous locale after switching. Replace success notice strings with semantic notice codes resolved by `NoticeBanner` using the current resource.

Normalize error notices into either:

- a known client-owned error code that maps to a translation resource, or
- an external opaque message that is displayed unchanged

Known locally generated errors such as invalid local-agent responses and generic request failures can re-render in the new locale. Backend payload messages remain unchanged because backend localization is out of scope.

### 7. Locale-aware formatting

Change timestamp formatting to accept the registered Intl language tag and call `Intl.DateTimeFormat`/`toLocaleString` with that tag. Listener addresses and other opaque values keep their current formatting.

Result/status badges translate only recognized UI concepts such as success, pending, failure, active, or revoked. Unknown server values remain unchanged.

## Data Flow

1. Browser starts the app.
2. `I18nProvider` reads persisted locale safely.
3. If no valid persisted locale exists, the pure resolver checks browser language metadata and applies the approved fallbacks.
4. The provider exposes the selected resource and updates the document language.
5. Administration components render translated chrome around the unchanged validated snapshot.
6. Selecting another locale updates provider state and storage.
7. Context consumers re-render in place; `AdministrationPage` state and API behavior are retained.

## Compatibility and Migration

- No backend, schema, URL, CSRF, or payload changes.
- Existing API fixtures remain valid.
- Existing hard-coded Chinese strings are moved, not behaviorally rewritten.
- Existing `App` tests are updated to control persisted/browser locale explicitly so test order and host browser language cannot affect assertions.
- The local-storage key contains only a locale ID; it does not contain security-sensitive data.

## Trade-offs

### Typed local layer instead of a third-party i18n runtime

The console is one eagerly loaded local React surface with two initial locales. A typed resource/context layer provides compile-time completeness, locale switching, persistence, formatting, and future registration without adding runtime dependencies or singleton test state. It intentionally does not implement ICU parsing. If future requirements add complex pluralization, remote bundle loading, or translator tooling, the registry/resources can be adapted behind the existing provider contract.

### Adaptive selector instead of a permanent segmented control

Segmented controls clearly expose two choices and match the approved prototype, but do not scale. Automatically switching the selector component to a native select when the registry grows keeps the current design while ensuring future locales require data registration rather than sidebar redesign in feature views.

## Risks and Mitigations

- **Missed hard-coded text:** audit all TSX string literals and accessible attributes; test representative output in every view.
- **Stale translated notice after switching:** store semantic codes, not rendered success strings.
- **Draft loss from remounting:** mount provider above `App` and never key `AdministrationPage` by locale.
- **Invalid persisted locale:** validate against registry and continue through browser fallback.
- **Storage access throws:** guard local-storage reads and writes.
- **Mixed localized/opaque data:** document and test the server-owned value boundary.
- **Future selector overflow:** adaptive two-button/select rendering based on registry size.

## Rollback

The feature is frontend-only. Reverting the provider, registry/resources, selector, and component string migration restores the previous static Chinese console without data migration. A persisted locale key can safely remain because older code ignores it.
