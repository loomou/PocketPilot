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
  formatTimestamp,
  inputClassName,
  ResultBadge,
} from "@/features/administration/administration-ui";
import { cn } from "@/lib/utils";

export function AuditView({ audits }: { audits: AuditRecord[] }) {
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
        audit.deviceId ?? "local",
        audit.taskId ?? "",
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [audits, query, resultFilter]);
  const hasFilters = query !== "" || resultFilter !== "all";

  return (
    <Card>
      <CardHeader>
        <CardTitle>审计记录</CardTitle>
        <CardDescription>
          搜索当前 Agent 快照中的操作、结果、设备与任务元数据。
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex items-center gap-3 border-y border-slate-200 bg-slate-50 px-5 py-3">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            />
            <input
              aria-label="搜索审计记录"
              className={cn(inputClassName, "pl-9")}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索操作、设备或任务 ID…"
              type="search"
              value={query}
            />
          </div>
          <label className="sr-only" htmlFor="audit-result-filter">
            按结果筛选审计记录
          </label>
          <select
            className={cn(inputClassName, "w-44")}
            id="audit-result-filter"
            onChange={(event) => setResultFilter(event.target.value)}
            value={resultFilter}
          >
            <option value="all">全部结果</option>
            {resultOptions.map((result) => (
              <option key={result} value={result}>
                {result}
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
              重置筛选
            </Button>
          ) : null}
        </div>

        {filteredAudits.length === 0 ? (
          <div className="flex min-h-96 flex-col items-center justify-center px-8 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              <Search aria-hidden="true" className="size-5" />
            </span>
            <h3 className="mt-4 text-sm font-semibold">
              {audits.length === 0 ? "暂无审计记录" : "没有匹配的审计记录"}
            </h3>
            <p className="mt-1 max-w-md text-sm leading-6 text-slate-500">
              {audits.length === 0
                ? "本地 Agent 尚未返回任何保留的审计元数据。"
                : "请尝试其他搜索词，或重置当前结果筛选。"}
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
                重置筛选
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-sm">
              <thead className="bg-white text-xs font-medium text-slate-500">
                <tr>
                  <th className="px-5 py-3">时间</th>
                  <th className="px-5 py-3">操作</th>
                  <th className="px-5 py-3">设备</th>
                  <th className="px-5 py-3">任务</th>
                  <th className="px-5 py-3">结果</th>
                </tr>
              </thead>
              <tbody>
                {filteredAudits.map((audit) => (
                  <tr className="border-t border-slate-100" key={audit.id}>
                    <td className="whitespace-nowrap px-5 py-3 text-xs text-slate-500">
                      {formatTimestamp(audit.occurredAt)}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">
                      {audit.operation}
                    </td>
                    <td className="max-w-56 truncate px-5 py-3 font-mono text-xs text-slate-500">
                      {audit.deviceId ?? "本地"}
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
          当前快照共 {audits.length} 条记录，显示 {filteredAudits.length} 条。
        </div>
      </CardContent>
    </Card>
  );
}
