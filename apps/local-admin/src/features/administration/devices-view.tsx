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
import { useI18n } from "@/lib/i18n/i18n-context";

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
  const { languageTag, messages } = useI18n();
  const [deviceToRevoke, setDeviceToRevoke] = useState<Device>();
  const activeDevices = snapshot.devices.filter(
    (device) => device.revokedAt === null,
  ).length;
  const revokedDevices = snapshot.devices.length - activeDevices;

  return (
    <div className="space-y-5">
      <section
        aria-label={messages.devices.deviceSummary}
        className="grid grid-cols-3 gap-4"
      >
        <SummaryCard
          icon={<ShieldCheck aria-hidden="true" className="size-4" />}
          label={messages.devices.summaries.paired}
          tone="success"
          value={activeDevices}
        />
        <SummaryCard
          icon={<Clock3 aria-hidden="true" className="size-4" />}
          label={messages.devices.summaries.pending}
          tone="warning"
          value={snapshot.pendingPairings.length}
        />
        <SummaryCard
          icon={<Ban aria-hidden="true" className="size-4" />}
          label={messages.devices.summaries.revoked}
          tone="destructive"
          value={revokedDevices}
        />
      </section>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-6">
          <div>
            <CardTitle>{messages.devices.pairingNew}</CardTitle>
            <CardDescription>
              {messages.devices.generatePairingDescription}
            </CardDescription>
          </div>
          <Button
            disabled={busyAction !== undefined}
            onClick={() => void onGeneratePairing()}
            size="sm"
            type="button"
          >
            <QrCode aria-hidden="true" className="size-3.5" />
            {messages.devices.generatePairing}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-800">
            {messages.devices.pairingDataDescription}{" "}
            {messages.devices.pairingDataSafety}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{messages.devices.pendingApproval}</CardTitle>
          <CardDescription>
            {messages.devices.pendingApprovalDescription}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {snapshot.pendingPairings.length === 0 ? (
            <EmptyDevices label={messages.devices.emptyPending} />
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
                        <Badge variant="warning">
                          {messages.common.statuses.pending}
                        </Badge>
                      </div>
                      <p className="mt-1 font-mono text-xs text-slate-500">
                        {messages.overview.agentCode(pending.verificationCode)}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {messages.overview.expiry(
                          formatTimestamp(pending.expiresAt, languageTag),
                        )}
                      </p>
                    </div>
                    <Field
                      id={`approval-${pending.pairingId}`}
                      label={messages.devices.approvalCode}
                    >
                      <input
                        aria-label={messages.devices.approvalCodeAria(
                          pending.deviceDisplayName,
                        )}
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
                      {messages.devices.approve}
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
          <CardTitle>{messages.devices.deviceList}</CardTitle>
          <CardDescription>
            {messages.devices.deviceListDescription}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {snapshot.devices.length === 0 ? (
            <EmptyDevices label={messages.devices.emptyDevices} />
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
                          {device.revokedAt === null
                            ? messages.devices.active
                            : messages.devices.revoked}
                        </Badge>
                      </div>
                      <p className="mt-1 truncate font-mono text-xs text-slate-500">
                        {device.id}
                      </p>
                    </div>
                  </div>
                  <div className="text-xs text-slate-500">
                    <p>{messages.devices.createdAt}</p>
                    <p className="mt-1 text-slate-700">
                      {formatTimestamp(device.createdAt, languageTag)}
                    </p>
                  </div>
                  <div className="flex justify-end">
                    {device.revokedAt === null ? (
                      <Button
                        aria-label={messages.devices.revokeAria(
                          device.displayName,
                        )}
                        disabled={busyAction !== undefined}
                        onClick={() => setDeviceToRevoke(device)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Ban aria-hidden="true" className="size-3.5" />
                        {messages.devices.revoke}
                      </Button>
                    ) : (
                      <span className="text-right text-xs text-red-700">
                        {formatTimestamp(device.revokedAt, languageTag)}
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
          description={messages.devices.qrDescription}
          onClose={onClosePairing}
          title={messages.devices.pairingNew}
        >
          <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-6">
            <div className="flex items-center justify-center rounded-md border border-slate-200 bg-white p-3">
              <img
                alt={messages.devices.qrAlt}
                className="size-48"
                src={pairing.qrUrl}
              />
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-slate-500">
                  {messages.devices.pairingId}
                </p>
                <p className="mt-1 break-all font-mono text-sm">
                  {pairing.pairingId}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">
                  {messages.devices.expiredAt}
                </p>
                <p className="mt-1 text-sm">
                  {formatTimestamp(pairing.expiresAt, languageTag)}
                </p>
              </div>
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                {messages.devices.qrStaticDescription}
              </div>
            </div>
          </div>
        </ModalDialog>
      )}

      {deviceToRevoke === undefined ? null : (
        <ModalDialog
          description={messages.devices.revokeDescription}
          onClose={() => setDeviceToRevoke(undefined)}
          title={messages.devices.revokeConfirmTitle}
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
              <Badge variant="success">{messages.devices.active}</Badge>
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
              {messages.devices.cancel}
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
              {messages.devices.revokeAccess}
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
  const { messages } = useI18n();
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
            aria-label={messages.devices.closeDialog}
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
