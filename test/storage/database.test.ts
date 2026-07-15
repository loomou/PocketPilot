import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { StorageDataError } from "../../src/storage/errors.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";

const settingsSchema = z.object({
  maxConcurrentTasks: z.number().int().min(1),
  workspaceRoots: z.array(z.string()),
});

describe("storage database", () => {
  const temporaryDirectories: string[] = [];
  const connections: StorageConnection[] = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("applies Drizzle migrations and enables SQLite foreign keys", () => {
    const connection = createTemporaryStorage(
      connections,
      temporaryDirectories,
    );
    const tableNames = connection.sqlite
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "agent_settings",
        "audit_records",
        "device_credentials",
        "devices",
        "event_overflow",
        "operation_results",
        "pairings",
        "tasks",
      ]),
    );
    expect(connection.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("validates settings when writing and reading persisted JSON", () => {
    const connection = createTemporaryStorage(
      connections,
      temporaryDirectories,
    );
    const settings = new SettingsRepository(connection.database);
    const expected = {
      maxConcurrentTasks: 3,
      workspaceRoots: ["C:\\Workspace"],
    };

    settings.set("runtime", expected, settingsSchema, 1);
    expect(settings.get("runtime", settingsSchema)).toEqual(expected);

    connection.sqlite
      .prepare("UPDATE agent_settings SET value_json = ? WHERE key = ?")
      .run('{"maxConcurrentTasks":"invalid"}', "runtime");

    expect(() => settings.get("runtime", settingsSchema)).toThrow(
      StorageDataError,
    );
  });
});

function createTemporaryStorage(
  connections: StorageConnection[],
  temporaryDirectories: string[],
): StorageConnection {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-storage-"));
  const connection = openStorage({
    databasePath: join(directory, "agent.sqlite"),
  });

  temporaryDirectories.push(directory);
  connections.push(connection);
  return connection;
}
