import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { type LocaleId, localeRegistry } from "@/lib/i18n/locale-registry";
import {
  persistLocale,
  readBrowserLanguages,
  readPersistedLocale,
  resolveInitialLocale,
} from "@/lib/i18n/locale-resolution";
import type { TranslationMessages } from "@/lib/i18n/message-schema";

type I18nContextValue = {
  languageTag: string;
  locale: LocaleId;
  messages: TranslationMessages;
  setLocale: (locale: LocaleId) => void;
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleId>(() =>
    resolveInitialLocale({
      browserLanguages: readBrowserLanguages(),
      persistedLocale: readPersistedLocale(),
    }),
  );
  const definition = localeRegistry[locale];

  useEffect(() => {
    document.documentElement.lang = definition.languageTag;
  }, [definition.languageTag]);

  const value = useMemo<I18nContextValue>(
    () => ({
      languageTag: definition.languageTag,
      locale,
      messages: definition.messages,
      setLocale: (nextLocale) => {
        persistLocale(nextLocale);
        setLocaleState(nextLocale);
      },
    }),
    [definition.languageTag, definition.messages, locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (value === undefined) {
    throw new Error("useI18n must be used within I18nProvider.");
  }
  return value;
}
