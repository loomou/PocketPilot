# Local Admin Internationalization Guidelines

## 1. Scope / Trigger

Apply this contract when adding or changing user-facing text, locale selection,
notices, errors, status labels, or locale-sensitive formatting in
`apps/local-admin`.

## 2. Signatures

- `LocaleId` is derived from the keys of `localeRegistry`.
- `localeRegistry` owns each locale's native label, HTML/Intl language tag,
  browser-language match tags, and complete message resource.
- `I18nProvider` owns the active locale and exposes `useI18n()` with
  `locale`, `languageTag`, `messages`, and `setLocale`.
- `resolveInitialLocale({ persistedLocale, browserLanguages }): LocaleId`
  implements startup selection without reading browser globals directly.

## 3. Contracts

- Keep one authoritative message tree and derive `TranslationMessages` by
  widening string leaves while preserving message-function signatures. Every
  additional locale must satisfy that complete schema at compile time.
- Startup locale priority is: valid persisted registry ID; registered browser
  match; English when a browser language exists but is not registered;
  Simplified Chinese when browser language is unavailable.
- Keep the provider above the stateful application. Locale changes must not
  remount `AdministrationPage` or discard its section, draft, loaded snapshot,
  approval codes, QR presentation, busy action, or notice state.
- Persist only the locale ID under the namespaced local-storage key. Guard both
  storage reads and writes so blocked storage does not prevent rendering or
  switching.
- Store client-owned notices and known errors as locale-neutral codes, then
  resolve them during render. Preserve validated, unknown backend error
  messages as opaque server-owned text.
- Keep server-owned URLs, listener values, IDs, device names, audit operation
  names, task IDs, filesystem paths, verification codes, and terminal commands
  unchanged.
- Pass the active registry `languageTag` into timestamp formatting. Translate
  only explicitly recognized status/result values; unrecognized values remain
  raw.
- The sidebar selector renders native-language labels from the registry. Two
  locales use the approved segmented buttons; more than two use a native
  select so the fixed-width sidebar does not overflow.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Persisted value is a registered locale ID | Use it before browser matching. |
| Persisted value is invalid | Ignore it and continue through browser resolution. |
| Browser language starts with a registered match tag | Select that registry locale. |
| Browser language exists but no locale matches | Use English. |
| Browser language is unavailable | Use Simplified Chinese. |
| Local storage throws on read or write | Continue rendering and allow in-memory switching. |
| Response payload fails local Zod validation | Show the localized invalid-response code. |
| Fetch/generic local request fails | Show the localized generic request-failure code. |
| Validated backend error has an unknown code/message | Display the backend message unchanged. |
| Audit result is not an explicitly recognized status | Display the raw result unchanged. |

## 5. Good / Base / Bad Cases

- Good: add a locale once in the registry with a schema-complete resource; the
  selector and browser matching consume it without component-specific branches.
- Base: switching between `zh-CN` and `en` immediately rerenders chrome and
  timestamps while preserving an unsaved Configuration draft.
- Bad: store a rendered success sentence in React state, compare locale IDs in
  every component, translate device names or audit operations, or remount the
  application by keying it with the locale.

## 6. Tests Required

- Cover persisted-locale precedence, registered browser tags, unknown browser
  languages, unavailable browser language, invalid persisted IDs, and blocked
  storage.
- Render representative Chinese and English output across the shell and all
  administration views.
- Assert switching updates `<html lang>` and local storage without losing the
  active section or unsaved form values.
- Assert locale-neutral notices and known errors rerender after switching.
- Assert unknown backend errors and server-owned URLs, IDs, names, operations,
  paths, and commands remain unchanged.
- Assert timestamps receive the active Intl language tag and unknown audit
  result values are not classified by substring.
- Preserve existing API mutation assertions, including paths, CSRF headers,
  JSON content type, and request payload values.

## 7. Wrong vs Correct

### Wrong

```tsx
setNotice({ kind: "success", message: "Configuration saved." });
return <AdministrationPage key={locale} />;
```

This freezes the old language in state and remounts all administration state
when the locale changes.

### Correct

```tsx
setNotice({ kind: "success", code: "configurationSaved" });

<I18nProvider>
  <App />
</I18nProvider>
```

`NoticeBanner` resolves the code from current messages, while the provider
updates context without replacing the stateful page.
