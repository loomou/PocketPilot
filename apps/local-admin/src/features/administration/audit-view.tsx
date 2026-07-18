import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { AuditRecord } from "@/api/local-admin";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatResultLabel,
  formatTimestamp,
  inputClassName,
  ResultBadge,
} from "@/features/administration/administration-ui";
import { useI18n } from "@/lib/i18n/i18n-context";
import { cn } from "@/lib/utils";

export function AuditView({ audits }: { audits: AuditRecord[] }) {
  const { languageTag, messages } = useI18n();
  const [query, setQuery] = useState("");
  const [resultFilter, setResultFilter] = useState("all");
  const resultOptions = useMemo(
    () => Array.from(new Set(audits.map((audit) => audit.result))).sort(),
    [audits],
  );
  const filteredAudits = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return audits.filter((audit) => {
      if (resultFilter !== "all" && audit.result !== resultFilter) return false;
      if (normalizedQuery === "") return true;
      return [
        audit.operation,
        audit.result,
        formatResultLabel(audit.result, messages),
        audit.deviceId ?? messages.audit.local,
        audit.taskId ?? "",
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [audits, messages, query, resultFilter]);
  const hasFilters = query !== "" || resultFilter !== "all";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{messages.audit.title}</CardTitle>
        <CardDescription>{messages.audit.description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex items-center gap-3 border-y border-slate-200 bg-slate-50 px-5 py-3">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            />
            <input
              aria-label={messages.audit.searchAria}
              className={cn(inputClassName, "pl-9")}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={messages.audit.searchPlaceholder}
              type="search"
              value={query}
            />
          </div>
          <label className="sr-only" htmlFor="audit-result-filter">
            {messages.audit.filterLabel}
          </label>
          <select
            className={cn(inputClassName, "w-44")}
            id="audit-result-filter"
            onChange={(event) => setResultFilter(event.target.value)}
            value={resultFilter}
          >
            <option value="all">{messages.audit.allResults}</option>
            {resultOptions.map((result) => (
              <option key={result} value={result}>
                {formatResultLabel(result, messages)}
              </option>
            ))}
          </select>
          {hasFilters ? (
            <Button
              onClick={() => {
                setQuery("");
                setResultFilter("all");
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <X aria-hidden="true" className="size-3.5" />
              {messages.audit.resetFilters}
            </Button>
          ) : null}
        </div>

        {filteredAudits.length === 0 ? (
          <div className="flex min-h-96 flex-col items-center justify-center px-8 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              <Search aria-hidden="true" className="size-5" />
            </span>
            <h3 className="mt-4 text-sm font-semibold">
              {audits.length === 0
                ? messages.audit.empty
                : messages.audit.noMatches}
            </h3>
            <p className="mt-1 max-w-md text-sm leading-6 text-slate-500">
              {audits.length === 0
                ? messages.audit.emptyDescription
                : messages.audit.noMatchesDescription}
            </p>
            {hasFilters ? (
              <Button
                className="mt-4"
                onClick={() => {
                  setQuery("");
                  setResultFilter("all");
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                {messages.audit.resetFilters}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-sm">
              <thead className="bg-white text-xs font-medium text-slate-500">
                <tr>
                  <th className="px-5 py-3">{messages.audit.table.time}</th>
                  <th className="px-5 py-3">
                    {messages.audit.table.operation}
                  </th>
                  <th className="px-5 py-3">{messages.audit.table.device}</th>
                  <th className="px-5 py-3">{messages.audit.table.task}</th>
                  <th className="px-5 py-3">{messages.audit.table.result}</th>
                </tr>
              </thead>
              <tbody>
                {filteredAudits.map((audit) => (
                  <tr className="border-t border-slate-100" key={audit.id}>
                    <td className="whitespace-nowrap px-5 py-3 text-xs text-slate-500">
                      {formatTimestamp(audit.occurredAt, languageTag)}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">
                      {audit.operation}
                    </td>
                    <td className="max-w-56 truncate px-5 py-3 font-mono text-xs text-slate-500">
                      {audit.deviceId ?? messages.audit.local}
                    </td>
                    <td className="max-w-56 truncate px-5 py-3 font-mono text-xs text-slate-500">
                      {audit.taskId ?? "-"}
                    </td>
                    <td className="px-5 py-3">
                      <ResultBadge result={audit.result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          {messages.audit.summary(audits.length, filteredAudits.length)}
        </div>
      </CardContent>
    </Card>
  );
}
