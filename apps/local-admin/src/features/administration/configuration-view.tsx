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
  return (
    <form className="space-y-5" onSubmit={onSave}>
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>运行设置</CardTitle>
            <CardDescription>
              监听器更改将在 Agent 下次启动时生效。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
              <Field id="remote-listener-host" label="远程监听地址">
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
              <Field id="remote-listener-port" label="端口">
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
              description="该地址会写入服务端生成的二维码，并提供给移动端。"
              id="mobile-base-url"
              label="移动端基础 URL"
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
            <CardTitle>任务策略</CardTitle>
            <CardDescription>
              限制并发任务数量与任务可访问的目录范围。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              description="Agent 可同时运行的最大任务数量。"
              id="concurrent-task-capacity"
              label="最大并发任务数"
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
              description="每行输入一个绝对工作区路径。"
              id="workspace-roots"
              label="工作区根目录"
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
              存在尚未保存的配置更改。
            </p>
            <p className="mt-0.5 text-xs text-amber-700">
              请同时保存运行设置与任务策略，或放弃本次更改。
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
              放弃更改
            </Button>
            <Button disabled={busy} size="sm" type="submit">
              <Save aria-hidden="true" className="size-3.5" />
              保存配置
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
