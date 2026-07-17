import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  it("migrates legacy task origins and terminalizes duplicate live session owners", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-migration-"));
    const databasePath = join(directory, "agent.sqlite");
    const legacyMigrations = join(directory, "legacy-drizzle");
    const legacyMeta = join(legacyMigrations, "meta");
    mkdirSync(legacyMeta, { recursive: true });
    for (const migration of [
      "0000_classy_firebrand.sql",
      "0001_bitter_tony_stark.sql",
      "0002_concerned_lockjaw.sql",
    ]) {
      copyFileSync(
        join(process.cwd(), "drizzle", migration),
        join(legacyMigrations, migration),
      );
    }
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    writeFileSync(
      join(legacyMeta, "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 3) }),
    );

    const legacy = openStorage({
      databasePath,
      migrationsFolder: legacyMigrations,
    });
    legacy.sqlite
      .prepare(
        "INSERT INTO tasks (id, initial_cwd, model, permission_mode, sdk_session_id, state, created_at, updated_at) VALUES (?, ?, NULL, 'default', ?, 'idle', ?, ?)",
      )
      .run("older", "C:\\workspace", "sdk-session", 1, 1);
    legacy.sqlite
      .prepare(
        "INSERT INTO tasks (id, initial_cwd, model, permission_mode, sdk_session_id, state, created_at, updated_at) VALUES (?, ?, NULL, 'default', ?, 'executing', ?, ?)",
      )
      .run("newer", "C:\\workspace", "sdk-session", 2, 2);
    legacy.close();

    const migrated = openStorage({ databasePath });
    const rows = migrated.sqlite
      .prepare(
        "SELECT id, origin, state, terminal_at AS terminalAt FROM tasks ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      {
        id: "newer",
        origin: "pocketpilot",
        state: "executing",
        terminalAt: null,
      },
      { id: "older", origin: "pocketpilot", state: "terminal", terminalAt: 1 },
    ]);
    expect(() =>
      migrated.sqlite
        .prepare(
          "INSERT INTO tasks (id, initial_cwd, origin, sdk_session_id, state, created_at, updated_at) VALUES (?, ?, 'claude-session', ?, 'idle', ?, ?)",
        )
        .run("duplicate", "C:\\workspace", "sdk-session", 3, 3),
    ).toThrow();
    migrated.close();
    temporaryDirectories.push(directory);
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
