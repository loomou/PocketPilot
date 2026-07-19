import { Save, Undo2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { Configuration } from "@/api/local-admin";
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
  inputClassName,
} from "@/features/administration/administration-ui";
import { WorkspaceAuthorization } from "@/features/administration/workspace-authorization";
import { useI18n } from "@/lib/i18n/i18n-context";

export function ConfigurationView({
  busy,
  configuration,
  csrfToken,
  dirty,
  onChange,
  onDiscard,
  onSave,
}: {
  busy: boolean;
  configuration: Configuration;
  csrfToken: string;
  dirty: boolean;
  onChange: (configuration: Configuration) => void;
  onDiscard: () => void;
  onSave: (confirmedHighRiskRoots: readonly string[]) => Promise<boolean>;
}) {
  const { messages } = useI18n();
  const [activeTab, setActiveTab] = useState<"authorized" | "general">(
    "general",
  );
  const [confirmedHighRiskRoots, setConfirmedHighRiskRoots] = useState<
    string[]
  >([]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (await onSave(confirmedHighRiskRoots)) {
      setConfirmedHighRiskRoots([]);
    }
  };

  const discard = () => {
    setConfirmedHighRiskRoots([]);
    onDiscard();
  };

  return (
    <form className="space-y-5" onSubmit={save}>
      <div aria-label={messages.configuration.configurationTabs} role="tablist">
        <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-1">
          <TabButton
            active={activeTab === "general"}
            label={messages.configuration.generalTab}
            onClick={() => setActiveTab("general")}
          />
          <TabButton
            active={activeTab === "authorized"}
            label={messages.configuration.authorizedTab}
            onClick={() => setActiveTab("authorized")}
          />
        </div>
      </div>

      {activeTab === "general" ? (
        <GeneralConfiguration
          configuration={configuration}
          onChange={onChange}
        />
      ) : (
        <WorkspaceAuthorization
          busy={busy}
          confirmedHighRiskRoots={confirmedHighRiskRoots}
          csrfToken={csrfToken}
          onConfirmedHighRiskRootsChange={setConfirmedHighRiskRoots}
          onWorkspaceRootsChange={(workspaceRoots) =>
            onChange({
              ...configuration,
              tasks: { ...configuration.tasks, workspaceRoots },
            })
          }
          workspaceRoots={configuration.tasks.workspaceRoots}
        />
      )}

      {dirty ? (
        <div className="sticky bottom-5 z-10 flex items-center justify-between gap-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 shadow-lg">
          <div>
            <p className="text-sm font-medium text-amber-950">
              {messages.configuration.dirtyTitle}
            </p>
            <p className="mt-0.5 text-xs text-amber-700">
              {messages.configuration.dirtyDescription}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={busy}
              onClick={discard}
              size="sm"
              type="button"
              variant="outline"
            >
              <Undo2 aria-hidden="true" className="size-3.5" />
              {messages.configuration.discardChanges}
            </Button>
            <Button disabled={busy} size="sm" type="submit">
              <Save aria-hidden="true" className="size-3.5" />
              {messages.configuration.saveChanges}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-selected={active}
      className={`rounded px-4 py-2 text-sm font-medium transition ${
        active
          ? "bg-white text-slate-950 shadow-sm"
          : "text-slate-600 hover:text-slate-950"
      }`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}

function GeneralConfiguration({
  configuration,
  onChange,
}: {
  configuration: Configuration;
  onChange: (configuration: Configuration) => void;
}) {
  const { messages } = useI18n();

  return (
    <div className="grid grid-cols-2 gap-4" role="tabpanel">
      <Card>
        <CardHeader>
          <CardTitle>{messages.configuration.runtimeSettings}</CardTitle>
          <CardDescription>
            {messages.configuration.runtimeDescription}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
            <Field
              id="remote-listener-host"
              label={messages.configuration.hostLabel}
            >
              <input
                className={inputClassName}
                id="remote-listener-host"
                onChange={(event) =>
                  onChange({
                    ...configuration,
                    runtime: {
                      ...configuration.runtime,
                      remoteListener: {
                        ...configuration.runtime.remoteListener,
                        host: event.target.value,
                      },
                    },
                  })
                }
                required
                value={configuration.runtime.remoteListener.host}
              />
            </Field>
            <Field
              id="remote-listener-port"
              label={messages.configuration.portLabel}
            >
              <input
                className={inputClassName}
                id="remote-listener-port"
                max={65_535}
                min={1}
                onChange={(event) =>
                  onChange({
                    ...configuration,
                    runtime: {
                      ...configuration.runtime,
                      remoteListener: {
                        ...configuration.runtime.remoteListener,
                        port: event.target.valueAsNumber,
                      },
                    },
                  })
                }
                required
                type="number"
                value={configuration.runtime.remoteListener.port}
              />
            </Field>
          </div>
          <Field
            description={messages.configuration.mobileBaseUrlDescription}
            id="mobile-base-url"
            label={messages.configuration.mobileBaseUrl}
          >
            <input
              className={inputClassName}
              id="mobile-base-url"
              onChange={(event) =>
                onChange({
                  ...configuration,
                  runtime: {
                    ...configuration.runtime,
                    mobileBaseUrl: withMobileBaseUrl(event.target.value),
                  },
                })
              }
              placeholder="https://example.ngrok.app"
              type="url"
              value={configuration.runtime.mobileBaseUrl ?? ""}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{messages.configuration.taskSettings}</CardTitle>
          <CardDescription>
            {messages.configuration.taskDescription}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field
            description={messages.configuration.concurrentDescription}
            id="concurrent-task-capacity"
            label={messages.configuration.concurrentLabel}
          >
            <input
              className={inputClassName}
              id="concurrent-task-capacity"
              max={1_024}
              min={1}
              onChange={(event) =>
                onChange({
                  ...configuration,
                  tasks: {
                    ...configuration.tasks,
                    concurrentTaskCapacity: event.target.valueAsNumber,
                  },
                })
              }
              required
              type="number"
              value={configuration.tasks.concurrentTaskCapacity}
            />
          </Field>
        </CardContent>
      </Card>
    </div>
  );
}

function withMobileBaseUrl(mobileBaseUrl: string): string | undefined {
  const trimmed = mobileBaseUrl.trim();
  return trimmed === "" ? undefined : trimmed;
}
