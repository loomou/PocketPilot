import { CircleAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Notice = { kind: "error" | "success"; message: string };

export const inputClassName =
  "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200";

export function Field({
  children,
  className,
  description,
  id,
  label,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  id: string;
  label: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label className="text-xs font-medium text-slate-700" htmlFor={id}>
        {label}
      </label>
      {children}
      {description === undefined ? null : (
        <p className="text-xs leading-5 text-slate-500">{description}</p>
      )}
    </div>
  );
}

export function NoticeBanner({ notice }: { notice: Notice | undefined }) {
  if (notice === undefined) return null;
  const isError = notice.kind === "error";
  return (
    <div
      aria-live="polite"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-4 py-3 text-sm shadow-sm",
        isError
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800",
      )}
      role={isError ? "alert" : "status"}
    >
      {isError ? (
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      ) : (
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      )}
      {notice.message}
    </div>
  );
}

export function ResultBadge({ result }: { result: string }) {
  const normalized = result.toLowerCase();
  const variant = normalized.includes("success")
    ? "success"
    : normalized.includes("pending")
      ? "warning"
      : normalized.includes("fail") || normalized.includes("error")
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{resultLabel(normalized, result)}</Badge>;
}

function resultLabel(normalized: string, fallback: string): string {
  if (normalized.includes("success")) return "成功";
  if (normalized.includes("pending")) return "待处理";
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "失败";
  }
  return fallback;
}

export function formatListener(listener: {
  host: string;
  port: number;
}): string {
  return `${listener.host}:${listener.port}`;
}

export function formatTimestamp(value: number | undefined): string {
  return value === undefined ? "-" : new Date(value).toLocaleString("zh-CN");
}
