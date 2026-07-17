import { afterEach, describe, expect, it } from "vitest";

import { buildLocalAdminApp } from "../../src/local-admin/app.js";
import { DirectorySelectionService } from "../../src/local-admin/directory-selection-service.js";
import { buildRemoteApiApp } from "../../src/remote-api/app.js";

const csrfHeaders = {
  origin: "http://127.0.0.1:43183",
  "x-pocketpilot-csrf-token": "csrf-token",
};

describe("local authorized-directory routes", () => {
  const apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("requires CSRF and adds only a single-use picker selection", async () => {
    const additions: unknown[] = [];
    const snapshot = {
      directories: [],
      revision: 0,
    };
    const selectionService = new DirectorySelectionService(
      {
        async pick() {
          return { path: "C:\\project", status: "selected" as const };
        },
      },
      {
        directoryResolver: {
          async canonicalizeDirectory(path) {
            return path;
          },
        },
      },
    );
    const app = await buildLocalAdminApp({
      authorizedDirectoryManager: {
        async addAuthorizedDirectory(input) {
          additions.push(input);
          return {
            removedRedundantPaths: [],
            result: "added" as const,
            selectedPath: input.selectedPath,
            snapshot,
          };
        },
        async authorizedDirectorySnapshot() {
          return snapshot;
        },
        async removeAuthorizedDirectory(input) {
          return {
            removedPath: input.path,
            snapshot,
            stoppedTaskCount: 0,
          };
        },
      },
      csrfProtection: {
        expectedOrigin: () => "http://127.0.0.1:43183",
        token: "csrf-token",
      },
      directorySelectionService: selectionService,
      getStatus: () => ({
        localAdminListener: { host: "127.0.0.1", port: 43_183 },
        remoteListener: { host: "127.0.0.1", port: 43_182 },
        status: "running" as const,
      }),
      requestShutdown: () => undefined,
      shutdownControlToken: "control-token",
    });
    apps.push(app);

    const rejected = await app.inject({
      method: "POST",
      url: "/admin/authorized-directories/pick",
    });
    expect(rejected.statusCode).toBe(403);

    const picked = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      url: "/admin/authorized-directories/pick",
    });
    expect(picked.statusCode).toBe(200);
    const selectionId = picked.json().selectionId as string;

    const arbitraryPath = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: {
        path: "D:\\not-picked",
        selectionId,
        volumeRootRiskAccepted: false,
      },
      url: "/admin/authorized-directories",
    });
    expect(arbitraryPath.statusCode).toBe(400);
    expect(additions).toEqual([]);

    const added = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { selectionId, volumeRootRiskAccepted: false },
      url: "/admin/authorized-directories",
    });
    expect(added.statusCode).toBe(200);
    expect(additions).toEqual([
      { selectedPath: "C:\\project", volumeRootRiskAccepted: false },
    ]);

    const reused = await app.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { selectionId, volumeRootRiskAccepted: false },
      url: "/admin/authorized-directories",
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({
      code: "DIRECTORY_SELECTION_UNAVAILABLE",
    });
  });

  it("keeps every authorization-management route off the remote app", async () => {
    const app = await buildRemoteApiApp();
    apps.push(app);

    for (const request of [
      { method: "GET", url: "/admin/authorized-directories" },
      { method: "POST", url: "/admin/authorized-directories/pick" },
      { method: "POST", url: "/admin/authorized-directories" },
      { method: "POST", url: "/admin/authorized-directories/remove" },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
    }
  });

  it("does not expose unexpected storage or runtime errors", async () => {
    const app = await buildLocalAdminApp({
      authorizedDirectoryManager: {
        async addAuthorizedDirectory() {
          throw new Error("raw sqlite path and statement");
        },
        async authorizedDirectorySnapshot() {
          throw new Error("raw sqlite path and statement");
        },
        async removeAuthorizedDirectory() {
          throw new Error("raw sqlite path and statement");
        },
      },
      csrfProtection: {
        expectedOrigin: () => "http://127.0.0.1:43183",
        token: "csrf-token",
      },
      directorySelectionService: new DirectorySelectionService({
        async pick() {
          return { status: "cancelled" as const };
        },
      }),
      getStatus: () => ({
        localAdminListener: { host: "127.0.0.1", port: 43_183 },
        remoteListener: { host: "127.0.0.1", port: 43_182 },
        status: "running" as const,
      }),
      requestShutdown: () => undefined,
      shutdownControlToken: "control-token",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/admin/authorized-directories",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: "LOCAL_ADMIN_OPERATION_FAILED",
      message: "The local administration operation failed.",
    });
    expect(response.body).not.toContain("sqlite");
  });
});
