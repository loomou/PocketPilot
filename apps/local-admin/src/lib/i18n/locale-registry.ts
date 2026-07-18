import type { TranslationMessages } from "@/lib/i18n/message-schema";
import { en } from "@/lib/i18n/messages/en";
import { zhCN } from "@/lib/i18n/messages/zh-cn";

type LocaleDefinition = {
  browserLanguageTags: readonly string[];
  languageTag: string;
  messages: TranslationMessages;
  nativeLabel: string;
};

export const localeRegistry = {
  "zh-CN": {
    browserLanguageTags: ["zh"],
    languageTag: "zh-CN",
    messages: zhCN,
    nativeLabel: "\u4e2d\u6587",
  },
  en: {
    browserLanguageTags: ["en"],
    languageTag: "en",
    messages: en,
    nativeLabel: "English",
  },
} as const satisfies Record<string, LocaleDefinition>;

export type LocaleId = keyof typeof localeRegistry;

export const localeIds = Object.keys(localeRegistry) as LocaleId[];

export const unavailableBrowserLocale: LocaleId = "zh-CN";
export const unknownBrowserLocale: LocaleId = "en";

export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === "string" && Object.hasOwn(localeRegistry, value);
}
