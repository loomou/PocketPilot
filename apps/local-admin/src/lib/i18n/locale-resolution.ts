import {
  isLocaleId,
  type LocaleId,
  localeIds,
  localeRegistry,
  unavailableBrowserLocale,
  unknownBrowserLocale,
} from "@/lib/i18n/locale-registry";

export const localeStorageKey = "pocketpilot.local-admin.locale";

export function resolveInitialLocale({
  browserLanguages,
  persistedLocale,
}: {
  browserLanguages: readonly string[];
  persistedLocale: string | null;
}): LocaleId {
  if (isLocaleId(persistedLocale)) return persistedLocale;

  const normalizedBrowserLanguages = browserLanguages
    .map(normalizeLanguageTag)
    .filter((language): language is string => language.length > 0);

  for (const browserLanguage of normalizedBrowserLanguages) {
    for (const localeId of localeIds) {
      const definition = localeRegistry[localeId];
      if (
        definition.browserLanguageTags.some((candidate) =>
          matchesLanguageTag(browserLanguage, candidate),
        )
      ) {
        return localeId;
      }
    }
  }

  return normalizedBrowserLanguages.length > 0
    ? unknownBrowserLocale
    : unavailableBrowserLocale;
}

export function readBrowserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  const languages = navigator.languages?.filter(Boolean) ?? [];
  if (languages.length > 0) return [...languages];
  return navigator.language ? [navigator.language] : [];
}

export function readPersistedLocale(): string | null {
  try {
    return globalThis.localStorage?.getItem(localeStorageKey) ?? null;
  } catch {
    return null;
  }
}

export function persistLocale(locale: LocaleId): void {
  try {
    globalThis.localStorage?.setItem(localeStorageKey, locale);
  } catch {
    // Locale switching must remain available when browser storage is blocked.
  }
}

function normalizeLanguageTag(value: string): string {
  return value.trim().replaceAll("_", "-").toLowerCase();
}

function matchesLanguageTag(
  browserLanguage: string,
  candidate: string,
): boolean {
  const normalizedCandidate = normalizeLanguageTag(candidate);
  return (
    browserLanguage === normalizedCandidate ||
    browserLanguage.startsWith(`${normalizedCandidate}-`)
  );
}
