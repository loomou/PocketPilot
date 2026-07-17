import { z } from "zod";

import type { SettingsRepository } from "../storage/settings-repository.js";

export const TASK_RUNTIME_SETTINGS_KEY = "task-runtime";
export const DEFAULT_CONCURRENT_TASK_CAPACITY = 3;

const workspaceRootSchema = z.string().trim().min(1).max(4_096);

export const taskRuntimeSettingsSchema = z.object({
  concurrentTaskCapacity: z.number().int().min(1).max(1_024),
  workspaceRoots: z.array(workspaceRootSchema).max(1_024),
});

export type TaskRuntimeSettings = z.infer<typeof taskRuntimeSettingsSchema>;

export const taskCapacitySettingsSchema = taskRuntimeSettingsSchema.pick({
  concurrentTaskCapacity: true,
});

export type TaskCapacitySettings = z.infer<typeof taskCapacitySettingsSchema>;

const defaultTaskRuntimeSettings: TaskRuntimeSettings = {
  concurrentTaskCapacity: DEFAULT_CONCURRENT_TASK_CAPACITY,
  workspaceRoots: [],
};

/** Reads task policy from one Zod-validated settings record. */
export function readTaskRuntimeSettings(
  settingsRepository: SettingsRepository,
): TaskRuntimeSettings {
  return (
    settingsRepository.get(
      TASK_RUNTIME_SETTINGS_KEY,
      taskRuntimeSettingsSchema,
    ) ?? defaultTaskRuntimeSettings
  );
}

/** Persists task policy for the local administration surface to manage later. */
export function writeTaskRuntimeSettings(
  settingsRepository: SettingsRepository,
  settings: TaskRuntimeSettings,
): void {
  settingsRepository.set(
    TASK_RUNTIME_SETTINGS_KEY,
    settings,
    taskRuntimeSettingsSchema,
  );
}

/** Updates local capacity without accepting or overwriting workspace roots. */
export function writeTaskCapacitySettings(
  settingsRepository: SettingsRepository,
  settings: TaskCapacitySettings,
): TaskCapacitySettings {
  const current = readTaskRuntimeSettings(settingsRepository);
  writeTaskRuntimeSettings(settingsRepository, {
    ...current,
    concurrentTaskCapacity: settings.concurrentTaskCapacity,
  });
  return settings;
}
