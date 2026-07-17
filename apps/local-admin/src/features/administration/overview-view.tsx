import {
  Activity,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Server,
  Smartphone,
} from "lucide-react";

import type { LocalAdminSnapshot } from "@/api/local-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AdminSection } from "@/features/administration/administration-shell";
import {
  formatListener,
  formatTimestamp,
  ResultBadge,
} from "@/features/administration/administration-ui";
import { cn } from "@/lib/utils";

export function OverviewView({
  onNavigate,
  snapshot,
}: {
  onNavigate: (section: AdminSection) => void;
  snapshot: LocalAdminSnapshot;
}) {
  const activeDevices = snapshot.devices.filter(
    (device) => device.revokedAt === null,
  ).length;
  const recentAudits = snapshot.audits.slice(0, 4);

  return (
    <div className="space-y-5">
      <section aria-label="Agent 总览" className="grid grid-cols-3 gap-4">
        <MetricCard
          detail={`本地管理 ${formatListener(snapshot.status.localAdminListener)}`}
          icon={<Activity aria-hidden="true" className="size-4" />}
          label="Agent 状态"
          tone="success"
          value="在线"
        />
        <MetricCard
          detail={`${snapshot.devices.length - activeDevices} 台已撤销`}
          icon={<Smartphone aria-hidden="true" className="size-4" />}
          label="活跃设备"
          value={String(activeDevices)}
        />
        <MetricCard
          detail="等待本地批准"
          icon={<Clock3 aria-hidden="true" className="size-4" />}
          label="待处理配对"
          tone={snapshot.pendingPairings.length > 0 ? "warning" : "default"}
          value={String(snapshot.pendingPairings.length)}
        />
      </section>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-6">
          <div>
            <CardTitle>Agent 状态</CardTitle>
            <CardDescription>
              当前监听器与服务端公布的移动端入口。
            </CardDescription>
          </div>
          <Badge variant="success">
            <CheckCircle2 aria-hidden="true" className="mr-1 size-3" />
            运行中
          </Badge>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-3 gap-4 rounded-md border border-slate-200 bg-slate-50 p-4">
            <StatusItem
              label="本地管理监听器"
              value={formatListener(snapshot.status.localAdminListener)}
            />
            <StatusItem
              label="远程监听器"
              value={formatListener(snapshot.status.remoteListener)}
            />
            <StatusItem
              label="移动端基础 URL"
              value={snapshot.status.mobileBaseUrl ?? "本次启动未配置"}
            />
          </dl>
        </CardContent>
      </Card>

      <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] gap-4">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>待处理设备批准</CardTitle>
              <CardDescription>
                授予访问权限前，请核对两端的六位验证码。
              </CardDescription>
            </div>
            <Button
              onClick={() => onNavigate("devices")}
              size="sm"
              type="button"
              variant="outline"
            >
              管理设备
              <ChevronRight aria-hidden="true" className="size-3.5" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {snapshot.pendingPairings.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
                当前没有等待批准的设备。
              </div>
            ) : (
              snapshot.pendingPairings.slice(0, 3).map((pairing) => (
                <div
                  className="flex items-center justify-between gap-4 rounded-md border border-slate-200 px-4 py-3"
                  key={pairing.pairingId}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {pairing.deviceDisplayName}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      到期时间 {formatTimestamp(pairing.expiresAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <Badge variant="warning">待处理</Badge>
                    <p className="mt-1 font-mono text-xs text-slate-600">
                      Agent 验证码 {pairing.verificationCode}
                    </p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>策略摘要</CardTitle>
            <CardDescription>当前运行配置与任务限制。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <PolicyItem
              label="最大并发任务数"
              value={String(
                snapshot.configuration.tasks.concurrentTaskCapacity,
              )}
            />
            <PolicyItem
              label="工作区根目录"
              value={String(snapshot.configuration.tasks.workspaceRoots.length)}
            />
            <PolicyItem
              label="远程监听器"
              value={formatListener(
                snapshot.configuration.runtime.remoteListener,
              )}
            />
            <Button
              className="w-full"
              onClick={() => onNavigate("configuration")}
              size="sm"
              type="button"
              variant="outline"
            >
              打开配置
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>近期活动</CardTitle>
            <CardDescription>Agent 返回的最新本地审计记录。</CardDescription>
          </div>
          <Button
            onClick={() => onNavigate("audit")}
            size="sm"
            type="button"
            variant="outline"
          >
            查看全部记录
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {recentAudits.length === 0 ? (
            <p className="border-t border-slate-100 px-5 py-10 text-center text-sm text-slate-500">
              暂无审计记录。
            </p>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <tr>
                  <th className="px-5 py-2.5">时间</th>
                  <th className="px-5 py-2.5">操作</th>
                  <th className="px-5 py-2.5">设备</th>
                  <th className="px-5 py-2.5">结果</th>
                </tr>
              </thead>
              <tbody>
                {recentAudits.map((audit) => (
                  <tr
                    className="border-b border-slate-100 last:border-0"
                    key={audit.id}
                  >
                    <td className="whitespace-nowrap px-5 py-3 text-xs text-slate-500">
                      {formatTimestamp(audit.occurredAt)}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">
                      {audit.operation}
                    </td>
                    <td className="max-w-56 truncate px-5 py-3 font-mono text-xs text-slate-500">
                      {audit.deviceId ?? "本地"}
                    </td>
                    <td className="px-5 py-3">
                      <ResultBadge result={audit.result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  detail,
  icon,
  label,
  tone = "default",
  value,
}: {
  detail: string;
  icon: React.ReactNode;
  label: string;
  tone?: "default" | "success" | "warning";
  value: string;
}) {
  const iconClass =
    tone === "success"
      ? "bg-emerald-50 text-emerald-700"
      : tone === "warning"
        ? "bg-amber-50 text-amber-700"
        : "bg-slate-100 text-slate-700";
  return (
    <Card>
      <CardContent className="flex items-start justify-between p-5">
        <div>
          <p className="text-xs font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
          <p className="mt-1 text-xs text-slate-500">{detail}</p>
        </div>
        <span
          className={cn(
            "flex size-8 items-center justify-center rounded-md",
            iconClass,
          )}
        >
          {icon}
        </span>
      </CardContent>
    </Card>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-2 text-xs font-medium text-slate-500">
        <Server aria-hidden="true" className="size-3.5" />
        {label}
      </dt>
      <dd className="mt-2 truncate font-mono text-xs" title={value}>
        {value}
      </dd>
    </div>
  );
}

function PolicyItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span
        className="max-w-48 truncate font-mono text-xs font-medium"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
