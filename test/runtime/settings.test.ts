import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_LISTENER_PORT,
  readRuntimeSettings,
  writeRuntimeSettings,
} from "../../src/runtime/settings.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";

describe("runtime settings", () => {
  const connections: StorageConnection[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("defaults to loopback and applies configured values on the next startup", () => {
    const settings = createSettingsRepository(
      connections,
      temporaryDirectories,
    );

    expect(readRuntimeSettings(settings)).toEqual({
      remoteListener: {
        host: "127.0.0.1",
        port: DEFAULT_REMOTE_LISTENER_PORT,
      },
    });

    writeRuntimeSettings(settings, {
      mobileBaseUrl: "https://agent.example.test",
      remoteListener: {
        host: "0.0.0.0",
        port: 45678,
      },
    });

    expect(readRuntimeSettings(settings)).toEqual({
      mobileBaseUrl: "https://agent.example.test",
      remoteListener: {
        host: "0.0.0.0",
        port: 45678,
      },
    });
  });
});

function createSettingsRepository(
  connections: StorageConnection[],
  temporaryDirectories: string[],
): SettingsRepository {
  const directory = mkdtempSync(
    join(tmpdir(), "pocketpilot-runtime-settings-"),
  );
  const connection = openStorage({
    databasePath: join(directory, "agent.sqlite"),
  });
  connections.push(connection);
  temporaryDirectories.push(directory);
  return new SettingsRepository(connection.database);
}
