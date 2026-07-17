import {
  Ban,
  Check,
  CircleAlert,
  Clock3,
  QrCode,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Device, LocalAdminSnapshot } from "@/api/local-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  formatTimestamp,
  inputClassName,
} from "@/features/administration/administration-ui";

export type PairingPresentation = {
  expiresAt: number;
  pairingId: string;
  qrUrl: string;
};

export function DevicesView({
  approvalCodes,
  busyAction,
  onApprovalCodeChange,
  onApprove,
  onClosePairing,
  onGeneratePairing,
  onRevoke,
  pairing,
  snapshot,
}: {
  approvalCodes: Record<string, string>;
  busyAction: string | undefined;
  onApprovalCodeChange: (pairingId: string, code: string) => void;
  onApprove: (pairingId: string) => Promise<void>;
  onClosePairing: () => void;
  onGeneratePairing: () => Promise<void>;
  onRevoke: (deviceId: string) => Promise<void>;
  pairing: PairingPresentation | undefined;
  snapshot: LocalAdminSnapshot;
}) {
  const [deviceToRevoke, setDeviceToRevoke] = useState<Device>();
  const activeDevices = snapshot.devices.filter(
    (device) => device.revokedAt === null,
  ).length;
  const revokedDevices = snapshot.devices.length - activeDevices;

  return (
    <div className="space-y-5">
      <section aria-label="设备摘要" className="grid grid-cols-3 gap-4">
        <SummaryCard
          icon={<ShieldCheck aria-hidden="true" className="size-4" />}
          label="已配对"
          tone="success"
          value={activeDevices}
        />
        <SummaryCard
          icon={<Clock3 aria-hidden="true" className="size-4" />}
          label="等待批准"
          tone="warning"
          value={snapshot.pendingPairings.length}
        />
        <SummaryCard
          icon={<Ban aria-hidden="true" className="size-4" />}
          label="已撤销"
          tone="destructive"
          value={revokedDevices}
        />
      </section>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-6">
          <div>
            <CardTitle>配对移动设备</CardTitle>
            <CardDescription>
              生成服务端签发的二维码，再核对并批准匹配的六位验证码。
            </CardDescription>
          </div>
          <Button
            disabled={busyAction !== undefined}
            onClick={() => void onGeneratePairing()}
            size="sm"
            type="button"
          >
            <QrCode aria-hidden="true" className="size-3.5" />
            生成配对二维码
          </Button>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-800">
            配对二维码数据由本地 Agent 返回，五分钟后过期，且仅可注册一台设备。
            浏览器不会自行构造或持久化这些数据。
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>待处理批准</CardTitle>
          <CardDescription>
            请确认 Agent 验证码与移动设备显示的验证码一致。
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {snapshot.pendingPairings.length === 0 ? (
            <EmptyDevices label="当前没有等待批准的设备。" />
          ) : (
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {snapshot.pendingPairings.map((pending) => {
                const approvalCode = approvalCodes[pending.pairingId] ?? "";
                return (
                  <div
                    className="grid grid-cols-[minmax(0,1fr)_190px_auto] items-end gap-4 px-5 py-4"
                    key={pending.pairingId}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">
                          {pending.deviceDisplayName}
                        </p>
                        <Badge variant="warning">待处理</Badge>
                      </div>
                      <p className="mt-1 font-mono text-xs text-slate-500">
                        Agent 验证码 {pending.verificationCode}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        到期时间 {formatTimestamp(pending.expiresAt)}
                      </p>
                    </div>
                    <Field
                      id={`approval-${pending.pairingId}`}
                      label="移动端验证码"
                    >
                      <input
                        aria-label={`${pending.deviceDisplayName} 的移动端验证码`}
                        className={inputClassName}
                        id={`approval-${pending.pairingId}`}
                        inputMode="numeric"
                        maxLength={6}
                        onChange={(event) =>
                          onApprovalCodeChange(
                            pending.pairingId,
                            event.target.value.replace(/\D/g, ""),
                          )
                        }
                        placeholder="000000"
                        value={approvalCode}
                      />
                    </Field>
                    <Button
                      disabled={
                        busyAction !== undefined || approvalCode.length !== 6
                      }
                      onClick={() => void onApprove(pending.pairingId)}
                      size="sm"
                      type="button"
                    >
                      <Check aria-hidden="true" className="size-3.5" />
                      批准
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>设备清单</CardTitle>
          <CardDescription>撤销后，所选设备的会话将立即失效。</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {snapshot.devices.length === 0 ? (
            <EmptyDevices label="尚未配对任何设备。" />
          ) : (
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {snapshot.devices.map((device) => (
                <div
                  className="grid grid-cols-[minmax(0,1fr)_180px_110px] items-center gap-4 px-5 py-4"
                  key={device.id}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600">
                      <Smartphone aria-hidden="true" className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">
                          {device.displayName}
                        </p>
                        <Badge
                          variant={
                            device.revokedAt === null
                              ? "success"
                              : "destructive"
                          }
                        >
                          {device.revokedAt === null ? "已配对" : "已撤销"}
                        </Badge>
                      </div>
                      <p className="mt-1 truncate font-mono text-xs text-slate-500">
                        {device.id}
                      </p>
                    </div>
                  </div>
                  <div className="text-xs text-slate-500">
                    <p>配对时间</p>
                    <p className="mt-1 text-slate-700">
                      {formatTimestamp(device.createdAt)}
                    </p>
                  </div>
                  <div className="flex justify-end">
                    {device.revokedAt === null ? (
                      <Button
                        aria-label={`撤销 ${device.displayName} 的访问权限`}
                        disabled={busyAction !== undefined}
                        onClick={() => setDeviceToRevoke(device)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Ban aria-hidden="true" className="size-3.5" />
                        撤销
                      </Button>
                    ) : (
                      <span className="text-right text-xs text-red-700">
                        {formatTimestamp(device.revokedAt)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {pairing === undefined ? null : (
        <ModalDialog
          description="请使用 PocketPilot 移动端扫描服务端签发的二维码。"
          onClose={onClosePairing}
          title="配对新设备"
        >
          <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-6">
            <div className="flex items-center justify-center rounded-md border border-slate-200 bg-white p-3">
              <img
                alt="PocketPilot 设备配对二维码"
                className="size-48"
                src={pairing.qrUrl}
              />
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-slate-500">配对 ID</p>
                <p className="mt-1 break-all font-mono text-sm">
                  {pairing.pairingId}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">到期时间</p>
                <p className="mt-1 text-sm">
                  {formatTimestamp(pairing.expiresAt)}
                </p>
              </div>
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                这些是服务端返回的静态配对数据。PocketPilot 不会保存二维码，
                也不会自行生成此处显示的任何标识符。
              </div>
            </div>
          </div>
        </ModalDialog>
      )}

      {deviceToRevoke === undefined ? null : (
        <ModalDialog
          description="此操作会立即使设备会话失效，且无法在浏览器中撤销。"
          onClose={() => setDeviceToRevoke(undefined)}
          title="确认撤销设备访问权限？"
          tone="destructive"
        >
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {deviceToRevoke.displayName}
                </p>
                <p className="mt-1 truncate font-mono text-xs text-slate-500">
                  {deviceToRevoke.id}
                </p>
              </div>
              <Badge variant="success">已配对</Badge>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              disabled={busyAction !== undefined}
              onClick={() => setDeviceToRevoke(undefined)}
              size="sm"
              type="button"
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={busyAction !== undefined}
              onClick={() => {
                void onRevoke(deviceToRevoke.id).then(() =>
                  setDeviceToRevoke(undefined),
                );
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              <Ban aria-hidden="true" className="size-3.5" />
              撤销访问权限
            </Button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  tone,
  value,
}: {
  icon: ReactNode;
  label: string;
  tone: "destructive" | "success" | "warning";
  value: number;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-xs font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold">{value}</p>
        </div>
        <Badge variant={tone}>{icon}</Badge>
      </CardContent>
    </Card>
  );
}

function EmptyDevices({ label }: { label: string }) {
  return (
    <p className="border-t border-slate-100 px-5 py-10 text-center text-sm text-slate-500">
      {label}
    </p>
  );
}

function ModalDialog({
  children,
  description,
  onClose,
  title,
  tone = "default",
}: {
  children: ReactNode;
  description: string;
  onClose: () => void;
  title: string;
  tone?: "default" | "destructive";
}) {
  return (
    <div
      aria-labelledby="admin-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-8"
      role="dialog"
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <div className="flex items-center gap-2">
              {tone === "destructive" ? (
                <CircleAlert
                  aria-hidden="true"
                  className="size-5 text-red-600"
                />
              ) : (
                <QrCode aria-hidden="true" className="size-5 text-slate-700" />
              )}
              <h2 className="text-base font-semibold" id="admin-dialog-title">
                {title}
              </h2>
            </div>
            <p className="mt-1.5 text-sm leading-5 text-slate-500">
              {description}
            </p>
          </div>
          <Button
            aria-label="关闭对话框"
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
