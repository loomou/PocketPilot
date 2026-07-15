import {
  Ban,
  Check,
  CircleAlert,
  KeyRound,
  Laptop,
  QrCode,
  RefreshCw,
  Save,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import QRCode from "qrcode";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
  approvePairing,
  createPairing,
  type LocalAdminSnapshot,
  loadLocalAdminSnapshot,
  type RuntimeSettings,
  revokeDevice,
  saveRuntimeSettings,
  saveTaskSettings,
} from "@/api/local-admin";
import { Button } from "@/components/ui/button";

type Notice = { kind: "error" | "success"; message: string };

export function AdministrationPage() {
  const [snapshot, setSnapshot] = useState<LocalAdminSnapshot>();
  const [notice, setNotice] = useState<Notice>();
  const [busyAction, setBusyAction] = useState<string>();
  const [approvalCodes, setApprovalCodes] = useState<Record<string, string>>(
    {},
  );
  const [pairingQrUrl, setPairingQrUrl] = useState<string>();
  const [pairingExpiry, setPairingExpiry] = useState<number>();

  const refresh = useCallback(async (preserveNotice = false) => {
    try {
      const next = await loadLocalAdminSnapshot();
      setSnapshot(next);
      if (!preserveNotice) setNotice(undefined);
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveConfiguration = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (snapshot === undefined) return;
    setBusyAction("save");
    try {
      const runtime = await saveRuntimeSettings(
        snapshot.csrfToken,
        snapshot.configuration.runtime,
      );
      const tasks = await saveTaskSettings(
        snapshot.csrfToken,
        snapshot.configuration.tasks,
      );
      setSnapshot({
        ...snapshot,
        configuration: { runtime, tasks },
      });
      setNotice({
        kind: "success",
        message: "Configuration saved. Listener changes apply on next start.",
      });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const generatePairing = async (): Promise<void> => {
    if (snapshot === undefined) return;
    setBusyAction("pairing");
    try {
      const pairing = await createPairing(snapshot.csrfToken);
      const svg = await QRCode.toString(JSON.stringify(pairing.qrPayload), {
        errorCorrectionLevel: "M",
        margin: 2,
        type: "svg",
        width: 240,
      });
      setPairingQrUrl(
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      );
      setPairingExpiry(pairing.expiresAt);
      setNotice({ kind: "success", message: "Pairing QR generated." });
      await refresh(true);
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
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
      setNotice({ kind: "success", message: "Device pairing approved." });
      await refresh(true);
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const revoke = async (deviceId: string): Promise<void> => {
    if (snapshot === undefined) return;
    setBusyAction(`revoke:${deviceId}`);
    try {
      await revokeDevice(snapshot.csrfToken, deviceId);
      setNotice({ kind: "success", message: "Device access revoked." });
      await refresh(true);
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const updateConfiguration = (
    configuration: LocalAdminSnapshot["configuration"],
  ): void => {
    setSnapshot((current) =>
      current === undefined ? current : { ...current, configuration },
    );
  };

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
              <Laptop aria-hidden="true" className="size-4" />
              PocketPilot local administration
            </div>
            <h1 className="mt-1 text-2xl font-semibold">Agent configuration</h1>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge running={snapshot?.status.status === "running"} />
            <Button
              aria-label="Refresh local administration data"
              disabled={busyAction !== undefined}
              onClick={() => void refresh()}
              size="icon"
              title="Refresh"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-8 px-5 py-7 sm:px-8">
        <NoticeBanner notice={notice} />

        {snapshot === undefined ? (
          <p className="py-16 text-center text-sm text-slate-600">
            Loading local Agent data...
          </p>
        ) : (
          <>
            <AgentStatusSection snapshot={snapshot} />

            <form className="space-y-5" onSubmit={saveConfiguration}>
              <SectionHeading
                action={
                  <Button disabled={busyAction !== undefined} type="submit">
                    <Save aria-hidden="true" className="size-4" />
                    Save configuration
                  </Button>
                }
                description="Remote listener changes take effect the next time the Agent starts."
                title="Runtime and task policy"
              />
              <div className="grid gap-5 border-y border-slate-200 bg-white p-5 sm:grid-cols-2">
                <Field id="mobile-base-url" label="Mobile base URL">
                  <input
                    className={inputClassName}
                    id="mobile-base-url"
                    onChange={(event) =>
                      updateConfiguration({
                        ...snapshot.configuration,
                        runtime: withMobileBaseUrl(
                          snapshot.configuration.runtime,
                          event.target.value,
                        ),
                      })
                    }
                    placeholder="https://example.ngrok.app"
                    type="url"
                    value={snapshot.configuration.runtime.mobileBaseUrl ?? ""}
                  />
                </Field>
                <Field id="remote-listener-host" label="Remote listener host">
                  <input
                    className={inputClassName}
                    id="remote-listener-host"
                    onChange={(event) =>
                      updateConfiguration({
                        ...snapshot.configuration,
                        runtime: {
                          ...snapshot.configuration.runtime,
                          remoteListener: {
                            ...snapshot.configuration.runtime.remoteListener,
                            host: event.target.value,
                          },
                        },
                      })
                    }
                    value={snapshot.configuration.runtime.remoteListener.host}
                  />
                </Field>
                <Field id="remote-listener-port" label="Remote listener port">
                  <input
                    className={inputClassName}
                    id="remote-listener-port"
                    max={65_535}
                    min={1}
                    onChange={(event) =>
                      updateConfiguration({
                        ...snapshot.configuration,
                        runtime: {
                          ...snapshot.configuration.runtime,
                          remoteListener: {
                            ...snapshot.configuration.runtime.remoteListener,
                            port: event.target.valueAsNumber,
                          },
                        },
                      })
                    }
                    type="number"
                    value={snapshot.configuration.runtime.remoteListener.port}
                  />
                </Field>
                <Field
                  id="concurrent-task-capacity"
                  label="Concurrent task capacity"
                >
                  <input
                    className={inputClassName}
                    id="concurrent-task-capacity"
                    max={1_024}
                    min={1}
                    onChange={(event) =>
                      updateConfiguration({
                        ...snapshot.configuration,
                        tasks: {
                          ...snapshot.configuration.tasks,
                          concurrentTaskCapacity: event.target.valueAsNumber,
                        },
                      })
                    }
                    type="number"
                    value={snapshot.configuration.tasks.concurrentTaskCapacity}
                  />
                </Field>
                <Field
                  className="sm:col-span-2"
                  id="workspace-roots"
                  label="Workspace roots"
                >
                  <textarea
                    className={`${inputClassName} min-h-28 resize-y`}
                    id="workspace-roots"
                    onChange={(event) =>
                      updateConfiguration({
                        ...snapshot.configuration,
                        tasks: {
                          ...snapshot.configuration.tasks,
                          workspaceRoots: parseWorkspaceRoots(
                            event.target.value,
                          ),
                        },
                      })
                    }
                    placeholder="C:\\code"
                    value={snapshot.configuration.tasks.workspaceRoots.join(
                      "\n",
                    )}
                  />
                </Field>
              </div>
            </form>

            <section aria-labelledby="pairing-title" className="space-y-5">
              <SectionHeading
                action={
                  <Button
                    disabled={busyAction !== undefined}
                    onClick={() => void generatePairing()}
                    type="button"
                  >
                    <QrCode aria-hidden="true" className="size-4" />
                    Generate QR
                  </Button>
                }
                description="Each QR expires after five minutes and can register one device."
                id="pairing-title"
                title="Pair a mobile device"
              />
              <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
                <div className="flex min-h-72 items-center justify-center border border-slate-200 bg-white p-5">
                  {pairingQrUrl === undefined ? (
                    <QrCode
                      aria-hidden="true"
                      className="size-14 text-slate-300"
                    />
                  ) : (
                    <div className="text-center">
                      <img
                        alt="PocketPilot device pairing QR code"
                        className="mx-auto size-60"
                        src={pairingQrUrl}
                      />
                      <p className="mt-2 text-xs text-slate-500">
                        Expires {formatTimestamp(pairingExpiry)}
                      </p>
                    </div>
                  )}
                </div>
                <div className="border-y border-slate-200 bg-white">
                  <h3 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold">
                    Pending approvals
                  </h3>
                  {snapshot.pendingPairings.length === 0 ? (
                    <EmptyRow label="No devices are waiting for approval." />
                  ) : (
                    snapshot.pendingPairings.map((pairing) => (
                      <div
                        className="grid gap-3 border-b border-slate-100 px-5 py-4 last:border-b-0 sm:grid-cols-[1fr_150px_auto] sm:items-end"
                        key={pairing.pairingId}
                      >
                        <div>
                          <p className="font-medium">
                            {pairing.deviceDisplayName}
                          </p>
                          <p className="mt-1 font-mono text-sm text-slate-600">
                            Agent code: {pairing.verificationCode}
                          </p>
                        </div>
                        <Field
                          id={`approval-${pairing.pairingId}`}
                          label="Mobile code"
                        >
                          <input
                            className={inputClassName}
                            id={`approval-${pairing.pairingId}`}
                            inputMode="numeric"
                            maxLength={6}
                            onChange={(event) =>
                              setApprovalCodes((current) => ({
                                ...current,
                                [pairing.pairingId]: event.target.value.replace(
                                  /\D/g,
                                  "",
                                ),
                              }))
                            }
                            value={approvalCodes[pairing.pairingId] ?? ""}
                          />
                        </Field>
                        <Button
                          disabled={
                            busyAction !== undefined ||
                            (approvalCodes[pairing.pairingId] ?? "").length !==
                              6
                          }
                          onClick={() => void approve(pairing.pairingId)}
                          type="button"
                        >
                          <Check aria-hidden="true" className="size-4" />
                          Approve
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

            <section aria-labelledby="devices-title" className="space-y-5">
              <SectionHeading
                description="Revocation immediately invalidates the selected device session."
                id="devices-title"
                title="Paired devices"
              />
              <div className="border-y border-slate-200 bg-white">
                {snapshot.devices.length === 0 ? (
                  <EmptyRow label="No devices have been paired." />
                ) : (
                  snapshot.devices.map((device) => (
                    <div
                      className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-5 py-4 last:border-b-0"
                      key={device.id}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Smartphone
                          aria-hidden="true"
                          className="size-5 shrink-0 text-slate-500"
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {device.displayName}
                          </p>
                          <p className="truncate font-mono text-xs text-slate-500">
                            {device.id}
                          </p>
                        </div>
                      </div>
                      {device.revokedAt === null ? (
                        <Button
                          disabled={busyAction !== undefined}
                          onClick={() => void revoke(device.id)}
                          type="button"
                          variant="outline"
                        >
                          <Ban aria-hidden="true" className="size-4" />
                          Revoke
                        </Button>
                      ) : (
                        <span className="text-sm font-medium text-red-700">
                          Revoked {formatTimestamp(device.revokedAt)}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>

            <section aria-labelledby="audits-title" className="space-y-5">
              <SectionHeading
                description="Control and security metadata retained by the Agent."
                id="audits-title"
                title="Audit records"
              />
              <div className="overflow-x-auto border-y border-slate-200 bg-white">
                <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                    <tr>
                      <th className="px-5 py-3">Time</th>
                      <th className="px-5 py-3">Operation</th>
                      <th className="px-5 py-3">Result</th>
                      <th className="px-5 py-3">Device</th>
                      <th className="px-5 py-3">Task</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.audits.length === 0 ? (
                      <tr>
                        <td
                          className="px-5 py-8 text-center text-slate-500"
                          colSpan={5}
                        >
                          No audit records.
                        </td>
                      </tr>
                    ) : (
                      snapshot.audits.map((audit) => (
                        <tr
                          className="border-t border-slate-100"
                          key={audit.id}
                        >
                          <td className="whitespace-nowrap px-5 py-3">
                            {formatTimestamp(audit.occurredAt)}
                          </td>
                          <td className="px-5 py-3 font-mono text-xs">
                            {audit.operation}
                          </td>
                          <td className="px-5 py-3">{audit.result}</td>
                          <td className="max-w-40 truncate px-5 py-3 font-mono text-xs">
                            {audit.deviceId ?? "Local"}
                          </td>
                          <td className="max-w-40 truncate px-5 py-3 font-mono text-xs">
                            {audit.taskId ?? "-"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section aria-labelledby="key-title" className="space-y-5 pb-8">
              <SectionHeading
                description="Key maintenance is available only from a local terminal while the Agent is stopped."
                id="key-title"
                title="Master key maintenance"
              />
              <div className="grid gap-px border border-slate-200 bg-slate-200 sm:grid-cols-2">
                <GuidanceBlock
                  icon={<KeyRound aria-hidden="true" className="size-5" />}
                  label="Rotate a known key"
                  text="Stop the Agent, provide the current and replacement master keys, then run agent rekey."
                />
                <GuidanceBlock
                  icon={<CircleAlert aria-hidden="true" className="size-5" />}
                  label="Recover from a lost key"
                  text="Run agent reset with explicit confirmation. Agent-managed devices and task metadata are removed; Claude credentials and sessions are untouched."
                />
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function AgentStatusSection({ snapshot }: { snapshot: LocalAdminSnapshot }) {
  const items = [
    {
      label: "Local administration",
      value: formatListener(snapshot.status.localAdminListener),
    },
    {
      label: "Remote listener",
      value: formatListener(snapshot.status.remoteListener),
    },
    {
      label: "Mobile base URL",
      value: snapshot.status.mobileBaseUrl ?? "Not configured at this start",
    },
  ];
  return (
    <section aria-labelledby="status-title" className="space-y-5">
      <SectionHeading id="status-title" title="Agent status" />
      <dl className="grid gap-px border border-slate-200 bg-slate-200 sm:grid-cols-3">
        {items.map((item) => (
          <div className="min-w-0 bg-white p-5" key={item.label}>
            <dt className="text-xs font-semibold uppercase text-slate-500">
              {item.label}
            </dt>
            <dd className="mt-2 truncate font-mono text-sm" title={item.value}>
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SectionHeading({
  action,
  description,
  id,
  title,
}: {
  action?: React.ReactNode;
  description?: string;
  id?: string;
  title: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold" id={id}>
          {title}
        </h2>
        {description === undefined ? null : (
          <p className="mt-1 text-sm text-slate-600">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

function Field({
  children,
  className,
  id,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  id: string;
  label: string;
}) {
  return (
    <div className={`block space-y-2 ${className ?? ""}`}>
      <label className="text-sm font-medium text-slate-700" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

function GuidanceBlock({
  icon,
  label,
  text,
}: {
  icon: React.ReactNode;
  label: string;
  text: string;
}) {
  return (
    <div className="bg-white p-5">
      <div className="flex items-center gap-2 font-medium text-slate-800">
        {icon}
        {label}
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
    </div>
  );
}

function NoticeBanner({ notice }: { notice: Notice | undefined }) {
  if (notice === undefined) return null;
  const isError = notice.kind === "error";
  return (
    <div
      aria-live="polite"
      className={`flex items-start gap-2 border px-4 py-3 text-sm ${
        isError
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800"
      }`}
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

function StatusBadge({ running }: { running: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 text-sm font-medium ${
        running ? "text-emerald-700" : "text-slate-500"
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${running ? "bg-emerald-500" : "bg-slate-400"}`}
      />
      {running ? "Running" : "Loading"}
    </span>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <p className="px-5 py-8 text-center text-sm text-slate-500">{label}</p>
  );
}

const inputClassName =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200";

function withMobileBaseUrl(
  settings: RuntimeSettings,
  mobileBaseUrl: string,
): RuntimeSettings {
  const { mobileBaseUrl: _omitted, ...settingsWithoutUrl } = settings;
  const trimmed = mobileBaseUrl.trim();
  return trimmed === ""
    ? settingsWithoutUrl
    : { ...settingsWithoutUrl, mobileBaseUrl: trimmed };
}

function parseWorkspaceRoots(value: string): string[] {
  return value
    .split("\n")
    .map((root) => root.trim())
    .filter((root) => root !== "");
}

function formatListener(listener: { host: string; port: number }): string {
  return `${listener.host}:${listener.port}`;
}

function formatTimestamp(value: number | undefined): string {
  return value === undefined ? "-" : new Date(value).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The local administration request failed.";
}
