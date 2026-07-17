import { CircleAlert, KeyRound, ShieldCheck, Terminal } from "lucide-react";

import type { LocalAdminSnapshot } from "@/api/local-admin";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatListener } from "@/features/administration/administration-ui";
import { cn } from "@/lib/utils";

export function MaintenanceView({
  snapshot,
}: {
  snapshot: LocalAdminSnapshot;
}) {
  const activeDevices = snapshot.devices.filter(
    (device) => device.revokedAt === null,
  ).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>安全元数据</CardTitle>
              <CardDescription>
                此本地浏览器控制台可见的运行时信息。
              </CardDescription>
            </div>
            <Badge variant="success">
              <ShieldCheck aria-hidden="true" className="mr-1 size-3" />
              仅限本地
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <MetadataItem
              label="本地管理监听器"
              value={formatListener(snapshot.status.localAdminListener)}
            />
            <MetadataItem
              label="远程监听器"
              value={formatListener(snapshot.status.remoteListener)}
            />
            <MetadataItem label="活跃配对设备" value={String(activeDevices)} />
            <MetadataItem
              label="保留的审计记录"
              value={String(snapshot.audits.length)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>操作前检查</CardTitle>
            <CardDescription>密钥操作仅允许在浏览器外执行。</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4">
              <Step number="1">访问存储前先停止 Agent。</Step>
              <Step number="2">在本地终端设置所需的主密钥环境变量。</Step>
              <Step number="3">
                在本地运行命令，然后重启 Agent 并刷新此控制台。
              </Step>
            </ol>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>仅限终端的密钥维护</CardTitle>
          <CardDescription>
            以下命令仅作指引。此页面无法执行命令，也无法访问密钥材料。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="flex items-start gap-2">
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <div>
                <p className="font-medium">继续前请先停止 Agent。</p>
                <p className="mt-1 text-xs leading-5 text-amber-800">
                  维护操作需要独占存储锁；Agent 运行时会拒绝执行。
                </p>
              </div>
            </div>
          </div>

          <CommandBlock
            description="提供当前 AGENT_MASTER_KEY 与不同的 AGENT_NEW_MASTER_KEY，然后重新加密由 Agent 管理的敏感记录。"
            icon={<KeyRound aria-hidden="true" className="size-4" />}
            label="轮换已知主密钥"
            value="agent rekey"
          />

          <div className="border-t border-red-100 pt-5">
            <CommandBlock
              description="仅在主密钥丢失后使用。此操作会移除由 Agent 管理的设备与任务元数据；外部凭据与会话不会受到影响。"
              icon={<CircleAlert aria-hidden="true" className="size-4" />}
              label="重置 Agent 管理的数据"
              tone="destructive"
              value="agent reset --confirm RESET_AGENT_DATA"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="font-mono text-xs font-medium">{value}</span>
    </div>
  );
}

function Step({
  children,
  number,
}: {
  children: React.ReactNode;
  number: string;
}) {
  return (
    <li className="flex items-start gap-3 text-sm leading-6 text-slate-600">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-700">
        {number}
      </span>
      {children}
    </li>
  );
}

function CommandBlock({
  description,
  icon,
  label,
  tone = "default",
  value,
}: {
  description: string;
  icon: React.ReactNode;
  label: string;
  tone?: "default" | "destructive";
  value: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      <div
        className={cn(
          "mt-3 flex items-center gap-3 rounded-md px-4 py-3 font-mono text-xs",
          tone === "destructive"
            ? "bg-red-950 text-red-50"
            : "bg-slate-950 text-slate-50",
        )}
      >
        <Terminal aria-hidden="true" className="size-4 shrink-0 opacity-70" />
        {value}
      </div>
    </div>
  );
}
