import { Languages } from "lucide-react";
import { useI18n } from "@/lib/i18n/i18n-context";
import {
  isLocaleId,
  localeIds,
  localeRegistry,
} from "@/lib/i18n/locale-registry";
import { cn } from "@/lib/utils";

export function LocaleSwitcher() {
  const { locale, messages, setLocale } = useI18n();

  return (
    <fieldset className="mt-5">
      <legend className="mb-2 flex items-center gap-2 px-0.5 text-[11px] font-semibold text-slate-500">
        <Languages aria-hidden="true" className="size-3.5" />
        {messages.shell.languageLabel}
      </legend>
      {localeIds.length <= 2 ? (
        <div className="grid grid-cols-2 rounded-md bg-slate-100 p-0.5">
          {localeIds.map((localeId) => (
            <button
              aria-pressed={localeId === locale}
              className={cn(
                "h-8 rounded-[5px] px-2 text-[11px] font-semibold transition-colors",
                localeId === locale
                  ? "bg-slate-950 text-white shadow-sm"
                  : "text-slate-500 hover:bg-white hover:text-slate-900",
              )}
              key={localeId}
              onClick={() => setLocale(localeId)}
              type="button"
            >
              {localeRegistry[localeId].nativeLabel}
            </button>
          ))}
        </div>
      ) : (
        <select
          aria-label={messages.shell.languageLabel}
          className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          onChange={(event) => {
            if (isLocaleId(event.target.value)) setLocale(event.target.value);
          }}
          value={locale}
        >
          {localeIds.map((localeId) => (
            <option key={localeId} value={localeId}>
              {localeRegistry[localeId].nativeLabel}
            </option>
          ))}
        </select>
      )}
    </fieldset>
  );
}
