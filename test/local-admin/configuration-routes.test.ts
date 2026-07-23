import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildLocalAdminApp } from "../../src/local-admin/app.js";
import { DirectoryBrowserService } from "../../src/local-admin/directory-browser-service.js";
import { buildRemoteApiApp } from "../../src/remote-api/app.js";
import { readRuntimeSettings } from "../../src/runtime/settings.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";
import { readTaskRuntimeSettings } from "../../src/tasks/settings.js";

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
      tasks: { concurrentTaskCapacity: 3, workspaceRoots: [] },
    });
  });

  it("rejects missing CSRF and persists valid same-origin settings", async () => {
    const { app, directory, settingsRepository } = await createLocalApp(
      apps,
      connections,
      directories,
    );
    const codeRoot = join(directory, "code");
    const workRoot = join(directory, "work");
    mkdirSync(codeRoot);
    mkdirSync(workRoot);
    const taskSettings = {
      concurrentTaskCapacity: 6,
      workspaceRoots: [codeRoot, workRoot],
    };
    const expectedTaskSettings = {
      concurrentTaskCapacity: 6,
      workspaceRoots: [
        realpathSync.native(codeRoot),
        realpathSync.native(workRoot),
      ],
    };
    const runtimeSettings = {
      mobileBaseUrl: "https://pocketpilot.example.test",
      remoteListener: { host: "0.0.0.0", port: 44_000 },
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
    expect(readTaskRuntimeSettings(settingsRepository)).toEqual(
      expectedTaskSettings,
    );
  });

  it("browses local directories with CSRF protection and filters files", async () => {
    const { app, directory } = await createLocalApp(
      apps,
      connections,
      directories,
    );
    const child = join(directory, "child");
    mkdirSync(child);

    const response = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { path: directory },
      url: "/admin/directories/browse",
    });
    const rejected = await app.inject({
      method: "POST",
      payload: { path: directory },
      url: "/admin/directories/browse",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      currentPath: realpathSync.native(directory),
      entries: [
        {
          accessible: true,
          name: "child",
          path: realpathSync.native(child),
          root: false,
        },
      ],
      truncated: false,
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({
      code: "LOCAL_ADMIN_CSRF_REJECTED",
    });
  });

  it("translates invalid and inaccessible browse requests without exposing files", async () => {
    const { app, directory } = await createLocalApp(
      apps,
      connections,
      directories,
    );
    const invalid = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { path: "relative/path" },
      url: "/admin/directories/browse",
    });
    const inaccessible = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { path: join(directory, "missing") },
      url: "/admin/directories/browse",
    });
    const malformed = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { path: 42 },
      url: "/admin/directories/browse",
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "DIRECTORY_PATH_INVALID" });
    expect(inaccessible.statusCode).toBe(422);
    expect(inaccessible.json()).toMatchObject({
      code: "DIRECTORY_NOT_ACCESSIBLE",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toHaveProperty("statusCode", 400);
    expect(inaccessible.body).not.toContain(join(directory, "missing"));
  });

  it("inspects directory status in request order and keeps the route local-only", async () => {
    const { app, directory } = await createLocalApp(
      apps,
      connections,
      directories,
    );
    const available = join(directory, "available");
    mkdirSync(available);
    const remoteApp = await buildRemoteApiApp();
    apps.push(remoteApp);

    const response = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { paths: [available, join(directory, "missing")] },
      url: "/admin/directories/inspect",
    });
    const remoteResponse = await remoteApp.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { path: directory },
      url: "/admin/directories/browse",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        canonicalPath: realpathSync.native(available),
        configuredPath: available,
        highRisk: false,
        status: "available",
      },
      {
        configuredPath: join(directory, "missing"),
        highRisk: false,
        status: "unavailable",
      },
    ]);
    expect(remoteResponse.statusCode).toBe(404);
  });

  it("returns a bounded listing and truncation metadata", async () => {
    const { app, directory } = await createLocalApp(
      apps,
      connections,
      directories,
      new DirectoryBrowserService({ maxEntries: 1 }),
    );
    mkdirSync(join(directory, "b"));
    mkdirSync(join(directory, "a"));

    const response = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { path: directory },
      url: "/admin/directories/browse",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entries: [{ name: "a" }],
      truncated: true,
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
        "INSERT INTO audit_records (id, occurred_at, operation, result, tool_name) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "00000000-0000-4000-8000-000000000001",
        1_700_000_000_000,
        "task.created",
        "success",
        null,
      );
    storage.sqlite
      .prepare(
        "INSERT INTO audit_records (id, occurred_at, operation, result, tool_name) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "00000000-0000-4000-8000-000000000002",
        1_700_000_000_001,
        "task.approval-approved",
        "allow",
        "Skill:claude-api",
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
    expect(response.json()).toEqual({
      items: [
        {
          deviceId: null,
          id: "00000000-0000-4000-8000-000000000002",
          occurredAt: 1_700_000_000_001,
          operation: "task.approval-approved",
          result: "allow",
          taskId: null,
          toolName: "Skill:claude-api",
        },
        {
          deviceId: null,
          id: "00000000-0000-4000-8000-000000000001",
          occurredAt: 1_700_000_000_000,
          operation: "task.created",
          result: "success",
          taskId: null,
          toolName: null,
        },
      ],
      limit: 50,
      offset: 0,
      total: 2,
    });
    expect(response.body).not.toContain("prompt");
    expect(response.body).not.toContain("modelOutput");
    expect(response.body).not.toContain("toolInput");
    expect(response.body).not.toContain("file_path");
    expect(response.body).not.toContain("command");
    expect(remoteResponse.statusCode).toBe(404);
  });

  it("returns an empty page and total for a fresh audit table", async () => {
    const { app } = await createLocalApp(apps, connections, directories);

    const response = await app.inject({ method: "GET", url: "/admin/audits" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [],
      limit: 50,
      offset: 0,
      total: 0,
    });
  });

  it("paginates, searches, and filters audits on the server", async () => {
    const { app, storage } = await createLocalApp(
      apps,
      connections,
      directories,
    );
    const insert = storage.sqlite.prepare(
      "INSERT INTO audit_records (id, occurred_at, operation, result, device_id, task_id, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (let index = 0; index < 5; index += 1) {
      insert.run(
        `00000000-0000-4000-8000-00000000010${index}`,
        1_700_000_000_000 + index,
        "task.created",
        "success",
        null,
        null,
        null,
      );
    }
    insert.run(
      "00000000-0000-4000-8000-000000000200",
      1_700_000_000_100,
      "task.approval-approved",
      "allow",
      null,
      null,
      "Skill:claude-api",
    );
    insert.run(
      "00000000-0000-4000-8000-000000000201",
      1_700_000_000_101,
      "task.approval-denied",
      "deny",
      null,
      null,
      "Bash",
    );

    const firstPage = await app.inject({
      method: "GET",
      url: "/admin/audits?limit=3&offset=0",
    });
    const secondPage = await app.inject({
      method: "GET",
      url: "/admin/audits?limit=3&offset=3",
    });
    const searchToolName = await app.inject({
      method: "GET",
      url: "/admin/audits?q=claude-api",
    });
    const searchOperation = await app.inject({
      method: "GET",
      url: "/admin/audits?q=approval",
    });
    const filterResult = await app.inject({
      method: "GET",
      url: "/admin/audits?result=deny",
    });
    const clampedLimit = await app.inject({
      method: "GET",
      url: "/admin/audits?limit=9999",
    });

    expect(firstPage.json()).toMatchObject({ limit: 3, offset: 0, total: 7 });
    expect(firstPage.json().items).toHaveLength(3);
    expect(secondPage.json()).toMatchObject({ limit: 3, offset: 3, total: 7 });
    expect(secondPage.json().items).toHaveLength(3);
    expect(searchToolName.json()).toMatchObject({ total: 1 });
    expect(searchToolName.json().items[0]).toMatchObject({
      toolName: "Skill:claude-api",
    });
    expect(searchOperation.json()).toMatchObject({ total: 2 });
    expect(filterResult.json()).toMatchObject({ total: 1 });
    expect(filterResult.json().items[0]).toMatchObject({
      operation: "task.approval-denied",
      result: "deny",
    });
    expect(clampedLimit.statusCode).toBe(200);
    expect(clampedLimit.json()).toMatchObject({ limit: 200, total: 7 });
  });

  it("clamps a negative offset and treats wildcards literally", async () => {
    const { app, storage } = await createLocalApp(
      apps,
      connections,
      directories,
    );
    const insert = storage.sqlite.prepare(
      "INSERT INTO audit_records (id, occurred_at, operation, result, tool_name) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(
      "00000000-0000-4000-8000-000000000300",
      1_700_000_000_000,
      "task.created",
      "success",
      null,
    );
    insert.run(
      "00000000-0000-4000-8000-000000000301",
      1_700_000_000_001,
      "task.100%done",
      "success",
      null,
    );

    const literalWildcard = await app.inject({
      method: "GET",
      url: `/admin/audits?q=${encodeURIComponent("100%")}`,
    });
    const negativeOffset = await app.inject({
      method: "GET",
      url: "/admin/audits?offset=-5",
    });

    expect(literalWildcard.json()).toMatchObject({ total: 1 });
    expect(literalWildcard.json().items[0]).toMatchObject({
      operation: "task.100%done",
    });
    expect(negativeOffset.json()).toMatchObject({ offset: 0, total: 2 });
  });
});

async function createLocalApp(
  apps: Array<{ close(): Promise<void> }>,
  connections: StorageConnection[],
  directories: string[],
  directoryBrowserService?: DirectoryBrowserService,
): Promise<{
  app: Awaited<ReturnType<typeof buildLocalAdminApp>>;
  settingsRepository: SettingsRepository;
  storage: StorageConnection;
  directory: string;
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

    ...(directoryBrowserService === undefined
      ? {}
      : { directoryBrowserService }),
    settingsRepository,
    shutdownControlToken: "runtime-control-token",
    sqlite: storage.sqlite,
  });
  directories.push(directory);
  connections.push(storage);
  apps.push(app);
  return { app, directory, settingsRepository, storage };
}
