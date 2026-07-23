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
import { useI18n } from "@/lib/i18n/i18n-context";
import { cn } from "@/lib/utils";

export function MaintenanceView({
  snapshot,
}: {
  snapshot: LocalAdminSnapshot;
}) {
  const { messages } = useI18n();
  const activeDevices = snapshot.devices.filter(
    (device) => device.revokedAt === null,
  ).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>{messages.maintenance.metadataTitle}</CardTitle>
              <CardDescription>
                {messages.maintenance.metadataDescription}
              </CardDescription>
            </div>
            <Badge variant="success">
              <ShieldCheck aria-hidden="true" className="mr-1 size-3" />
              {messages.maintenance.localOnly}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <MetadataItem
              label={messages.maintenance.localAdminListener}
              value={formatListener(snapshot.status.localAdminListener)}
            />
            <MetadataItem
              label={messages.maintenance.remoteListener}
              value={formatListener(snapshot.status.remoteListener)}
            />
            <MetadataItem
              label={messages.maintenance.activePairings}
              value={String(activeDevices)}
            />
            <MetadataItem
              label={messages.maintenance.retainedAudits}
              value={String(snapshot.auditsTotal)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.maintenance.preflightTitle}</CardTitle>
            <CardDescription>
              {messages.maintenance.preflightDescription}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4">
              <Step number="1">{messages.maintenance.stepOne}</Step>
              <Step number="2">{messages.maintenance.stepTwo}</Step>
              <Step number="3">{messages.maintenance.stepThree}</Step>
            </ol>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{messages.maintenance.terminalTitle}</CardTitle>
          <CardDescription>
            {messages.maintenance.terminalDescription}
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
                <p className="font-medium">
                  {messages.maintenance.stopAgentTitle}
                </p>
                <p className="mt-1 text-xs leading-5 text-amber-800">
                  {messages.maintenance.stopAgentDescription}
                </p>
              </div>
            </div>
          </div>

          <CommandBlock
            description={messages.maintenance.rotateDescription}
            icon={<KeyRound aria-hidden="true" className="size-4" />}
            label={messages.maintenance.rotateLabel}
            value="agent rekey"
          />

          <div className="border-t border-red-100 pt-5">
            <CommandBlock
              description={messages.maintenance.resetDescription}
              icon={<CircleAlert aria-hidden="true" className="size-4" />}
              label={messages.maintenance.resetLabel}
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
