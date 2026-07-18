import { Save, Undo2 } from "lucide-react";
import type { FormEvent } from "react";

import type { Configuration, RuntimeSettings } from "@/api/local-admin";
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
import { useI18n } from "@/lib/i18n/i18n-context";
import { cn } from "@/lib/utils";

export function ConfigurationView({
  busy,
  configuration,
  dirty,
  onChange,
  onDiscard,
  onSave,
}: {
  busy: boolean;
  configuration: Configuration;
  dirty: boolean;
  onChange: (configuration: Configuration) => void;
  onDiscard: () => void;
  onSave: (event: FormEvent) => void;
}) {
  const { messages } = useI18n();

  return (
    <form className="space-y-5" onSubmit={onSave}>
      <div className="grid grid-cols-2 gap-4">
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
                    runtime: withMobileBaseUrl(
                      configuration.runtime,
                      event.target.value,
                    ),
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
          <CardContent className="space-y-4">
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
            <Field
              description={messages.configuration.workspaceRootsDescription}
              id="workspace-roots"
              label={messages.configuration.workspaceRootsLabel}
            >
              <textarea
                className={cn(inputClassName, "min-h-32 resize-y py-2")}
                id="workspace-roots"
                onChange={(event) =>
                  onChange({
                    ...configuration,
                    tasks: {
                      ...configuration.tasks,
                      workspaceRoots: parseWorkspaceRoots(event.target.value),
                    },
                  })
                }
                placeholder="C:\\code"
                value={configuration.tasks.workspaceRoots.join("\n")}
              />
            </Field>
          </CardContent>
        </Card>
      </div>

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
              onClick={onDiscard}
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
