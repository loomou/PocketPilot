import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildLocalAdminApp } from "../../src/local-admin/app.js";
import { buildRemoteApiApp } from "../../src/remote-api/app.js";
import { readRuntimeSettings } from "../../src/runtime/settings.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";
import {
  readTaskRuntimeSettings,
  writeTaskRuntimeSettings,
} from "../../src/tasks/settings.js";

const csrfHeaders = {
  origin: "http://127.0.0.1:43183",
  "x-pocketpilot-csrf-token": "csrf-token",
};

describe("local administration configuration routes", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  const connections: StorageConnection[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const connection of connections.splice(0)) connection.close();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("returns fresh-install runtime and task defaults", async () => {
    const { app } = await createLocalApp(apps, connections, directories);

    const response = await app.inject({
      method: "GET",
      url: "/admin/configuration",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      runtime: {
        remoteListener: { host: "127.0.0.1", port: 43_182 },
      },
      tasks: { concurrentTaskCapacity: 3 },
    });
  });

  it("rejects missing CSRF and persists valid same-origin settings", async () => {
    const { app, settingsRepository } = await createLocalApp(
      apps,
      connections,
      directories,
    );
    const runtimeSettings = {
      mobileBaseUrl: "https://pocketpilot.example.test",
      remoteListener: { host: "0.0.0.0", port: 44_000 },
    };
    writeTaskRuntimeSettings(settingsRepository, {
      concurrentTaskCapacity: 3,
      workspaceRoots: ["C:\\code", "D:\\work"],
    });
    const taskSettings = {
      concurrentTaskCapacity: 6,
    };

    const rejected = await app.inject({
      method: "PUT",
      payload: runtimeSettings,
      url: "/admin/configuration/runtime",
    });
    const savedRuntime = await app.inject({
      headers: csrfHeaders,
      method: "PUT",
      payload: runtimeSettings,
      url: "/admin/configuration/runtime",
    });
    const savedTasks = await app.inject({
      headers: csrfHeaders,
      method: "PUT",
      payload: taskSettings,
      url: "/admin/configuration/tasks",
    });

    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({
      code: "LOCAL_ADMIN_CSRF_REJECTED",
    });
    expect(savedRuntime.statusCode).toBe(200);
    expect(savedTasks.statusCode).toBe(200);
    expect(readRuntimeSettings(settingsRepository)).toEqual(runtimeSettings);
    expect(readTaskRuntimeSettings(settingsRepository)).toEqual({
      ...taskSettings,
      workspaceRoots: ["C:\\code", "D:\\work"],
    });
  });

  it("returns metadata-only audits and keeps admin routes off the remote app", async () => {
    const { app, storage } = await createLocalApp(
      apps,
      connections,
      directories,
    );
    const remoteApp = await buildRemoteApiApp();
    apps.push(remoteApp);
    storage.sqlite
      .prepare(
        "INSERT INTO audit_records (id, occurred_at, operation, result) VALUES (?, ?, ?, ?)",
      )
      .run(
        "00000000-0000-4000-8000-000000000001",
        1_700_000_000_000,
        "task.created",
        "success",
      );

    const response = await app.inject({
      method: "GET",
      url: "/admin/audits",
    });
    const remoteResponse = await remoteApp.inject({
      method: "GET",
      url: "/admin/configuration",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        deviceId: null,
        id: "00000000-0000-4000-8000-000000000001",
        occurredAt: 1_700_000_000_000,
        operation: "task.created",
        result: "success",
        taskId: null,
      },
    ]);
    expect(response.body).not.toContain("prompt");
    expect(response.body).not.toContain("modelOutput");
    expect(response.body).not.toContain("toolInput");
    expect(remoteResponse.statusCode).toBe(404);
  });
});

async function createLocalApp(
  apps: Array<{ close(): Promise<void> }>,
  connections: StorageConnection[],
  directories: string[],
): Promise<{
  app: Awaited<ReturnType<typeof buildLocalAdminApp>>;
  settingsRepository: SettingsRepository;
  storage: StorageConnection;
}> {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-admin-config-"));
  const storage = openStorage({
    databasePath: join(directory, "agent.sqlite"),
  });
  const settingsRepository = new SettingsRepository(storage.database);
  const app = await buildLocalAdminApp({
    csrfProtection: {
      expectedOrigin: () => "http://127.0.0.1:43183",
      token: "csrf-token",
    },
    getStatus: () => ({
      localAdminListener: { host: "127.0.0.1", port: 43_183 },
      remoteListener: { host: "127.0.0.1", port: 43_182 },
      status: "running" as const,
    }),
    requestShutdown: () => undefined,
    settingsRepository,
    shutdownControlToken: "runtime-control-token",
    sqlite: storage.sqlite,
  });
  directories.push(directory);
  connections.push(storage);
  apps.push(app);
  return { app, settingsRepository, storage };
}
