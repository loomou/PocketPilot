import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type AuditRecord, getAudits } from "@/api/local-admin";
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

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Known audit result values used to populate the result filter. The dropdown
 * no longer derives options from the current page, so filtering by a value that
 * is absent from the visible rows still works.
 */
const KNOWN_AUDIT_RESULTS = [
  "allow",
  "deny",
  "success",
  "accepted",
  "forwarded",
  "resolved",
  "changed",
  "interrupted",
  "resumed",
  "created",
  "closed",
] as const;

export function AuditView() {
  const { languageTag, messages } = useI18n();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [resultFilter, setResultFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<AuditRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      // A changed search term always restarts from the first page.
      setDebouncedQuery(query.trim());
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setFailed(false);
    getAudits({
      limit: PAGE_SIZE,
      offset,
      ...(debouncedQuery === "" ? {} : { q: debouncedQuery }),
      ...(resultFilter === "all" ? {} : { result: resultFilter }),
    })
      .then((page) => {
        if (currentRequest !== requestId.current) return;
        setItems(page.items);
        setTotal(page.total);
        setLoading(false);
      })
      .catch(() => {
        if (currentRequest !== requestId.current) return;
        setItems([]);
        setTotal(0);
        setFailed(true);
        setLoading(false);
      });
  }, [debouncedQuery, offset, resultFilter]);

  const hasFilters = query !== "" || resultFilter !== "all";
  const resetFilters = () => {
    setQuery("");
    setResultFilter("all");
    setOffset(0);
  };
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + items.length, total);
  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

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
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
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
            onChange={(event) => {
              setResultFilter(event.target.value);
              setOffset(0);
            }}
            value={resultFilter}
          >
            <option value="all">{messages.audit.allResults}</option>
            {KNOWN_AUDIT_RESULTS.map((result) => (
              <option key={result} value={result}>
                {formatResultLabel(result, messages)}
              </option>
            ))}
          </select>
          {hasFilters ? (
            <Button
              onClick={resetFilters}
              size="sm"
              type="button"
              variant="outline"
            >
              <X aria-hidden="true" className="size-3.5" />
              {messages.audit.resetFilters}
            </Button>
          ) : null}
        </div>

        {items.length === 0 ? (
          <div className="flex min-h-96 flex-col items-center justify-center px-8 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              <Search aria-hidden="true" className="size-5" />
            </span>
            <h3 className="mt-4 text-sm font-semibold">
              {loading
                ? messages.audit.loading
                : failed
                  ? messages.audit.loadFailed
                  : hasFilters
                    ? messages.audit.noMatches
                    : messages.audit.empty}
            </h3>
            <p className="mt-1 max-w-md text-sm leading-6 text-slate-500">
              {loading
                ? messages.audit.loadingDescription
                : failed
                  ? messages.audit.loadFailedDescription
                  : hasFilters
                    ? messages.audit.noMatchesDescription
                    : messages.audit.emptyDescription}
            </p>
            {hasFilters && !loading ? (
              <Button
                className="mt-4"
                onClick={resetFilters}
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
                  <th className="px-5 py-3">{messages.audit.table.tool}</th>
                  <th className="px-5 py-3">{messages.audit.table.device}</th>
                  <th className="px-5 py-3">{messages.audit.table.task}</th>
                  <th className="px-5 py-3">{messages.audit.table.result}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((audit) => (
                  <tr className="border-t border-slate-100" key={audit.id}>
                    <td className="whitespace-nowrap px-5 py-3 text-xs text-slate-500">
                      {formatTimestamp(audit.occurredAt, languageTag)}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">
                      {audit.operation}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">
                      {audit.toolName ?? "-"}
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
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          <span>{messages.audit.summary(total, pageStart, pageEnd)}</span>
          <div className="flex items-center gap-2">
            <Button
              disabled={!hasPrevious || loading}
              onClick={() =>
                setOffset((current) => Math.max(0, current - PAGE_SIZE))
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {messages.audit.previousPage}
            </Button>
            <Button
              disabled={!hasNext || loading}
              onClick={() => setOffset((current) => current + PAGE_SIZE)}
              size="sm"
              type="button"
              variant="outline"
            >
              {messages.audit.nextPage}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
