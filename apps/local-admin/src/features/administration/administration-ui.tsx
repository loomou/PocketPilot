import { CircleAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n/i18n-context";
import type { TranslationMessages } from "@/lib/i18n/message-schema";
import { cn } from "@/lib/utils";

export type NoticeCode = keyof TranslationMessages["notices"];
export type ErrorCode = keyof TranslationMessages["errors"];
export type Notice =
  | { kind: "success"; code: NoticeCode }
  | { kind: "error"; code: ErrorCode }
  | { kind: "error"; message: string };

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
  const { messages } = useI18n();
  if (notice === undefined) return null;
  const isError = notice.kind === "error";
  const message =
    "message" in notice
      ? notice.message
      : notice.kind === "success"
        ? messages.notices[notice.code]
        : messages.errors[notice.code];
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
      {message}
    </div>
  );
}

export function ResultBadge({ result }: { result: string }) {
  const { messages } = useI18n();
  const status = recognizedResultStatus(result);
  const variant =
    status === "success"
      ? "success"
      : status === "pending"
        ? "warning"
        : status === "failed"
          ? "destructive"
          : "secondary";
  return <Badge variant={variant}>{formatResultLabel(result, messages)}</Badge>;
}

export function formatResultLabel(
  result: string,
  messages: TranslationMessages,
): string {
  const status = recognizedResultStatus(result);
  return status === undefined ? result : messages.common.statuses[status];
}

function recognizedResultStatus(
  result: string,
): "failed" | "pending" | "success" | undefined {
  switch (result.trim().toLowerCase()) {
    case "success":
    case "succeeded":
      return "success";
    case "pending":
      return "pending";
    case "error":
    case "fail":
    case "failed":
    case "failure":
      return "failed";
    default:
      return undefined;
  }
}

export function formatListener(listener: {
  host: string;
  port: number;
}): string {
  return `${listener.host}:${listener.port}`;
}

export function formatTimestamp(
  value: number | undefined,
  languageTag: string,
): string {
  return value === undefined
    ? "-"
    : new Date(value).toLocaleString(languageTag);
}
