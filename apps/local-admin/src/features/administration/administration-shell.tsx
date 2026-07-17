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
import { cn } from "@/lib/utils";

export type AdminSection =
  | "overview"
  | "configuration"
  | "devices"
  | "audit"
  | "maintenance";

const navigationItems = [
  { icon: LayoutDashboard, id: "overview", label: "总览" },
  { icon: Settings2, id: "configuration", label: "配置" },
  { icon: Smartphone, id: "devices", label: "设备" },
  { icon: ScrollText, id: "audit", label: "审计记录" },
  { icon: Shield, id: "maintenance", label: "维护" },
] as const;

export const sectionDetails: Record<
  AdminSection,
  { description: string; title: string }
> = {
  audit: {
    description: "检查本地控制、配置与安全事件的审计元数据。",
    title: "审计记录",
  },
  configuration: {
    description: "调整运行端点、工作区访问范围与任务容量。",
    title: "配置",
  },
  devices: {
    description: "配对可信移动端，并管理现有设备的访问权限。",
    title: "设备",
  },
  maintenance: {
    description: "查看安全元数据与仅限终端执行的恢复指引。",
    title: "维护",
  },
  overview: {
    description: "检查 Agent 健康、当前策略、设备与近期活动。",
    title: "总览",
  },
};

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
  const details = sectionDetails[activeSection];

  return (
    <main className="grid min-h-screen min-w-[1080px] grid-cols-[224px_minmax(0,1fr)] bg-slate-100 text-slate-950">
      <aside className="sticky top-0 flex h-screen flex-col border-r border-slate-200 bg-white">
        <div className="flex h-17 items-center gap-3 border-b border-slate-100 px-5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-slate-950 text-white">
            <Laptop aria-hidden="true" className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold">PocketPilot</p>
            <p className="text-[11px] text-slate-500">本地管理控制台</p>
          </div>
        </div>

        <nav aria-label="管理控制台导航" className="space-y-1 p-3">
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
                {item.label}
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
              {running ? "本地 Agent 正在运行" : "正在加载本地 Agent"}
            </div>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">
              此控制台仅能通过本地管理监听器访问。
            </p>
          </div>
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
                {running ? "运行正常" : "加载中"}
              </span>
              <Button
                aria-label="刷新本地管理数据"
                disabled={refreshDisabled}
                onClick={onRefresh}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                刷新
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
