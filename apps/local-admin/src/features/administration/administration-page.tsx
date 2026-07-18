import QRCode from "qrcode";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
  approvePairing,
  createPairing,
  LocalAdminApiError,
  type LocalAdminSnapshot,
  loadLocalAdminSnapshot,
  revokeDevice,
  saveRuntimeSettings,
  saveTaskSettings,
} from "@/api/local-admin";
import {
  AdministrationShell,
  type AdminSection,
} from "@/features/administration/administration-shell";
import {
  type Notice,
  NoticeBanner,
} from "@/features/administration/administration-ui";
import { AuditView } from "@/features/administration/audit-view";
import { ConfigurationView } from "@/features/administration/configuration-view";
import {
  DevicesView,
  type PairingPresentation,
} from "@/features/administration/devices-view";
import { MaintenanceView } from "@/features/administration/maintenance-view";
import { OverviewView } from "@/features/administration/overview-view";
import { useI18n } from "@/lib/i18n/i18n-context";

export function AdministrationPage() {
  const { messages } = useI18n();
  const [activeSection, setActiveSection] = useState<AdminSection>("overview");
  const [snapshot, setSnapshot] = useState<LocalAdminSnapshot>();
  const [configurationDraft, setConfigurationDraft] =
    useState<LocalAdminSnapshot["configuration"]>();
  const [notice, setNotice] = useState<Notice>();
  const [busyAction, setBusyAction] = useState<string>();
  const [approvalCodes, setApprovalCodes] = useState<Record<string, string>>(
    {},
  );
  const [pairing, setPairing] = useState<PairingPresentation>();

  const refresh = useCallback(async (preserveNotice = false) => {
    try {
      const next = await loadLocalAdminSnapshot();
      setSnapshot(next);
      setConfigurationDraft(next.configuration);
      if (!preserveNotice) setNotice(undefined);
    } catch (error) {
      setNotice(errorNotice(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveConfiguration = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (snapshot === undefined || configurationDraft === undefined) return;
    setBusyAction("save");
    try {
      const runtime = await saveRuntimeSettings(
        snapshot.csrfToken,
        configurationDraft.runtime,
      );
      const tasks = await saveTaskSettings(
        snapshot.csrfToken,
        configurationDraft.tasks,
      );
      const configuration = { runtime, tasks };
      setSnapshot({ ...snapshot, configuration });
      setConfigurationDraft(configuration);
      setNotice({ kind: "success", code: "configurationSaved" });
    } catch (error) {
      setNotice(errorNotice(error));
    } finally {
      setBusyAction(undefined);
    }
  };

  const generatePairing = async (): Promise<void> => {
    if (snapshot === undefined) return;
    setBusyAction("pairing");
    try {
      const createdPairing = await createPairing(snapshot.csrfToken);
      const svg = await QRCode.toString(
        JSON.stringify(createdPairing.qrPayload),
        {
          errorCorrectionLevel: "M",
          margin: 2,
          type: "svg",
          width: 240,
        },
      );
      setPairing({
        expiresAt: createdPairing.expiresAt,
        pairingId: createdPairing.pairingId,
        qrUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      });
      setNotice({ kind: "success", code: "pairingQrGenerated" });
      await refresh(true);
    } catch (error) {
      setNotice(errorNotice(error));
    } finally {
      setBusyAction(undefined);
    }
  };

  const approve = async (pairingId: string): Promise<void> => {
    if (snapshot === undefined) return;
    const verificationCode = approvalCodes[pairingId] ?? "";
    setBusyAction(`approve:${pairingId}`);
    try {
      await approvePairing(snapshot.csrfToken, pairingId, verificationCode);
      setApprovalCodes((current) => {
        const next = { ...current };
        delete next[pairingId];
        return next;
      });
      setNotice({ kind: "success", code: "pairingApproved" });
      await refresh(true);
    } catch (error) {
      setNotice(errorNotice(error));
    } finally {
      setBusyAction(undefined);
    }
  };

  const revoke = async (deviceId: string): Promise<void> => {
    if (snapshot === undefined) return;
    setBusyAction(`revoke:${deviceId}`);
    try {
      await revokeDevice(snapshot.csrfToken, deviceId);
      setNotice({ kind: "success", code: "deviceRevoked" });
      await refresh(true);
    } catch (error) {
      setNotice(errorNotice(error));
    } finally {
      setBusyAction(undefined);
    }
  };

  const configurationDirty =
    snapshot !== undefined &&
    configurationDraft !== undefined &&
    !sameConfiguration(snapshot.configuration, configurationDraft);

  return (
    <AdministrationShell
      activeSection={activeSection}
      notice={<NoticeBanner notice={notice} />}
      onNavigate={setActiveSection}
      onRefresh={() => void refresh()}
      refreshDisabled={busyAction !== undefined}
      running={snapshot?.status.status === "running"}
    >
      {snapshot === undefined || configurationDraft === undefined ? (
        <LoadingState failed={notice?.kind === "error"} messages={messages} />
      ) : (
        <ActiveView
          activeSection={activeSection}
          approvalCodes={approvalCodes}
          busyAction={busyAction}
          configurationDraft={configurationDraft}
          configurationDirty={configurationDirty}
          onApprovalCodeChange={(pairingId, code) =>
            setApprovalCodes((current) => ({
              ...current,
              [pairingId]: code,
            }))
          }
          onApprove={approve}
          onClosePairing={() => setPairing(undefined)}
          onConfigurationChange={setConfigurationDraft}
          onDiscardConfiguration={() =>
            setConfigurationDraft(snapshot.configuration)
          }
          onGeneratePairing={generatePairing}
          onNavigate={setActiveSection}
          onRevoke={revoke}
          onSaveConfiguration={saveConfiguration}
          pairing={pairing}
          snapshot={snapshot}
        />
      )}
    </AdministrationShell>
  );
}

function ActiveView({
  activeSection,
  approvalCodes,
  busyAction,
  configurationDraft,
  configurationDirty,
  onApprovalCodeChange,
  onApprove,
  onClosePairing,
  onConfigurationChange,
  onDiscardConfiguration,
  onGeneratePairing,
  onNavigate,
  onRevoke,
  onSaveConfiguration,
  pairing,
  snapshot,
}: {
  activeSection: AdminSection;
  approvalCodes: Record<string, string>;
  busyAction: string | undefined;
  configurationDraft: LocalAdminSnapshot["configuration"];
  configurationDirty: boolean;
  onApprovalCodeChange: (pairingId: string, code: string) => void;
  onApprove: (pairingId: string) => Promise<void>;
  onClosePairing: () => void;
  onConfigurationChange: (
    configuration: LocalAdminSnapshot["configuration"],
  ) => void;
  onDiscardConfiguration: () => void;
  onGeneratePairing: () => Promise<void>;
  onNavigate: (section: AdminSection) => void;
  onRevoke: (deviceId: string) => Promise<void>;
  onSaveConfiguration: (event: FormEvent) => void;
  pairing: PairingPresentation | undefined;
  snapshot: LocalAdminSnapshot;
}) {
  switch (activeSection) {
    case "overview":
      return <OverviewView onNavigate={onNavigate} snapshot={snapshot} />;
    case "configuration":
      return (
        <ConfigurationView
          busy={busyAction !== undefined}
          configuration={configurationDraft}
          dirty={configurationDirty}
          onChange={onConfigurationChange}
          onDiscard={onDiscardConfiguration}
          onSave={onSaveConfiguration}
        />
      );
    case "devices":
      return (
        <DevicesView
          approvalCodes={approvalCodes}
          busyAction={busyAction}
          onApprovalCodeChange={onApprovalCodeChange}
          onApprove={onApprove}
          onClosePairing={onClosePairing}
          onGeneratePairing={onGeneratePairing}
          onRevoke={onRevoke}
          pairing={pairing}
          snapshot={snapshot}
        />
      );
    case "audit":
      return <AuditView audits={snapshot.audits} />;
    case "maintenance":
      return <MaintenanceView snapshot={snapshot} />;
  }
}

function LoadingState({
  failed,
  messages,
}: {
  failed: boolean;
  messages: ReturnType<typeof useI18n>["messages"];
}) {
  return (
    <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="max-w-sm text-center">
        <span className="mx-auto block size-8 animate-pulse rounded-full bg-slate-200" />
        <p className="mt-4 text-sm font-medium">
          {failed ? messages.errors.loadingFailed : messages.shell.loadingAgent}
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          {failed
            ? messages.errors.loadingDescriptionFailed
            : messages.errors.loadingDescription}
        </p>
      </div>
    </div>
  );
}

function sameConfiguration(
  current: LocalAdminSnapshot["configuration"],
  draft: LocalAdminSnapshot["configuration"],
): boolean {
  return JSON.stringify(current) === JSON.stringify(draft);
}

function errorNotice(error: unknown): Notice {
  if (error instanceof LocalAdminApiError) {
    if (error.code === "LOCAL_ADMIN_RESPONSE_INVALID") {
      return { kind: "error", code: "invalidResponse" };
    }
    if (error.code === "LOCAL_ADMIN_REQUEST_FAILED") {
      return { kind: "error", code: "localRequestFailed" };
    }
    return { kind: "error", message: error.message };
  }
  return { kind: "error", code: "localRequestFailed" };
}
