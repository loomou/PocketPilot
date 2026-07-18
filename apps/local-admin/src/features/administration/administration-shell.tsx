import {
  Laptop,
  LayoutDashboard,
  RefreshCw,
  ScrollText,
  Settings2,
  Shield,
  Smartphone,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { LocaleSwitcher } from "@/features/administration/locale-switcher";
import { useI18n } from "@/lib/i18n/i18n-context";
import { cn } from "@/lib/utils";

export type AdminSection =
  | "overview"
  | "configuration"
  | "devices"
  | "audit"
  | "maintenance";

const navigationItems = [
  { icon: LayoutDashboard, id: "overview" },
  { icon: Settings2, id: "configuration" },
  { icon: Smartphone, id: "devices" },
  { icon: ScrollText, id: "audit" },
  { icon: Shield, id: "maintenance" },
] as const;

export function AdministrationShell({
  activeSection,
  children,
  notice,
  onNavigate,
  onRefresh,
  refreshDisabled,
  running,
}: {
  activeSection: AdminSection;
  children: ReactNode;
  notice: ReactNode;
  onNavigate: (section: AdminSection) => void;
  onRefresh: () => void;
  refreshDisabled: boolean;
  running: boolean;
}) {
  const { messages } = useI18n();
  const details = messages.shell.section[activeSection];

  return (
    <main className="grid min-h-screen min-w-[1080px] grid-cols-[224px_minmax(0,1fr)] bg-slate-100 text-slate-950">
      <aside className="sticky top-0 flex h-screen flex-col border-r border-slate-200 bg-white">
        <div className="flex h-17 items-center gap-3 border-b border-slate-100 px-5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-slate-950 text-white">
            <Laptop aria-hidden="true" className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold">PocketPilot</p>
            <p className="text-[11px] text-slate-500">
              {messages.shell.brandSubtitle}
            </p>
          </div>
        </div>

        <nav
          aria-label={messages.shell.navigationLabel}
          className="space-y-1 p-3"
        >
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const selected = item.id === activeSection;
            return (
              <button
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition-colors",
                  selected
                    ? "bg-slate-100 text-slate-950"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-950",
                )}
                key={item.id}
                onClick={() => onNavigate(item.id)}
                type="button"
              >
                <Icon aria-hidden="true" className="size-4" />
                {messages.shell.nav[item.id]}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto p-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 rounded-full",
                  running ? "bg-emerald-500" : "bg-slate-400",
                )}
              />
              {running
                ? messages.shell.runningAgent
                : messages.shell.loadingAgent}
            </div>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">
              {messages.shell.localAccessDescription}
            </p>
          </div>
          <LocaleSwitcher />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex h-17 items-center justify-between gap-6 px-8">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                {details.title}
              </h1>
              <p className="mt-0.5 text-xs text-slate-500">
                {details.description}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium",
                  running
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-slate-100 text-slate-600",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    running ? "bg-emerald-500" : "bg-slate-400",
                  )}
                />
                {running
                  ? messages.shell.runningStatus
                  : messages.shell.loadingStatus}
              </span>
              <Button
                aria-label={messages.shell.refreshAria}
                disabled={refreshDisabled}
                onClick={onRefresh}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                {messages.shell.refresh}
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-[1320px] space-y-5 px-8 py-7">
          {notice}
          {children}
        </div>
      </div>
    </main>
  );
}
