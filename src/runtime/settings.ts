import { z } from "zod";

import type { SettingsRepository } from "../storage/settings-repository.js";

export const RUNTIME_SETTINGS_KEY = "runtime";
export const DEFAULT_REMOTE_LISTENER_PORT = 43_182;
export const DEFAULT_LOCAL_ADMIN_PORT = 43_183;
export const LOCAL_ADMIN_HOST = "127.0.0.1";

const listenerHostSchema = z.string().trim().min(1).max(255);
const listenerPortSchema = z.number().int().min(1).max(65_535);

export const runtimeSettingsSchema = z.object({
  mobileBaseUrl: z.url().optional(),
  remoteListener: z.object({
    host: listenerHostSchema,
    port: listenerPortSchema,
  }),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

const defaultRuntimeSettings: RuntimeSettings = {
  remoteListener: {
    host: "127.0.0.1",
    port: DEFAULT_REMOTE_LISTENER_PORT,
  },
};

/** Reads settings once at manual startup; live listeners never hot-reload. */
export function readRuntimeSettings(
  settingsRepository: SettingsRepository,
): RuntimeSettings {
  return (
    settingsRepository.get(RUNTIME_SETTINGS_KEY, runtimeSettingsSchema) ??
    defaultRuntimeSettings
  );
}

/** Persists settings that will be applied only by the next manual start. */
export function writeRuntimeSettings(
  settingsRepository: SettingsRepository,
  settings: RuntimeSettings,
): void {
  settingsRepository.set(RUNTIME_SETTINGS_KEY, settings, runtimeSettingsSchema);
}
