import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";
import { writeTaskRuntimeSettings } from "../../src/tasks/settings.js";
import { WorkspaceAuthorizationCoordinator } from "../../src/tasks/workspace-authorization-coordinator.js";
import type { WorkspacePathFileSystem } from "../../src/tasks/workspace-path-policy.js";

function createFileSystem(
  paths: Readonly<Record<string, { canonical: string; directory?: boolean }>>,
): WorkspacePathFileSystem {
  return {
    async realpath(path) {
      const entry = paths[path];
      if (entry === undefined) {
        throw new Error("missing");
      }
      return entry.canonical;
    },
    async stat(path) {
      const entry = Object.values(paths).find(
        (candidate) => candidate.canonical === path,
      );
      return { isDirectory: () => entry?.directory !== false };
    },
  };
}
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
describe("WorkspaceAuthorizationCoordinator", () => {
  const connections: StorageConnection[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  function createCoordinator(
    fileSystem: WorkspacePathFileSystem,
    workspaceRoots: string[],
  ): WorkspaceAuthorizationCoordinator {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-policy-"));
    const connection = openStorage({
      databasePath: join(directory, "agent.sqlite"),
    });
    connections.push(connection);
    directories.push(directory);
    const settingsRepository = new SettingsRepository(connection.database);
    writeTaskRuntimeSettings(settingsRepository, {
      concurrentTaskCapacity: 3,
      workspaceRoots,
    });
    return new WorkspaceAuthorizationCoordinator({
      fileSystem,
      settingsRepository,
    });
  }

  it("preserves unchanged unavailable roots while canonicalizing available roots", async () => {
    const coordinator = createCoordinator(
      createFileSystem({
        "/saved": { canonical: "/saved" },
        "/new": { canonical: "/canonical/new" },
        "/canonical/new": { canonical: "/canonical/new" },
      }),
      ["/saved", "/missing"],
    );

    await expect(
      coordinator.replaceTaskRuntimeSettings({
        concurrentTaskCapacity: 4,
        workspaceRoots: ["/canonical/new", "/missing"],
      }),
    ).resolves.toEqual({
      concurrentTaskCapacity: 4,
      workspaceRoots: ["/canonical/new", "/missing"],
    });
  });

  it("rejects newly unavailable roots, canonical duplicates, and unconfirmed volume roots", async () => {
    const coordinator = createCoordinator(
      createFileSystem({
        "/one": { canonical: "/one" },
        "/alias": { canonical: "/one" },
        "/volume": { canonical: "/" },
        "/": { canonical: "/" },
      }),
      [],
    );

    await expect(
      coordinator.replaceTaskRuntimeSettings({
        concurrentTaskCapacity: 3,
        workspaceRoots: ["/missing"],
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNAVAILABLE",
    });
    await expect(
      coordinator.replaceTaskRuntimeSettings({
        concurrentTaskCapacity: 3,
        workspaceRoots: ["/one", "/alias"],
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_ROOT_DUPLICATE" });
    await expect(
      coordinator.replaceTaskRuntimeSettings({
        concurrentTaskCapacity: 3,
        workspaceRoots: ["/volume"],
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_ROOT_HIGH_RISK_CONFIRMATION_REQUIRED",
    });
  });

  it("admits current canonical descendants and omits unavailable discovery roots", async () => {
    const coordinator = createCoordinator(
      createFileSystem({
        "/root": { canonical: "/root" },
        "/root/child": { canonical: "/root/child" },
      }),
      ["/root", "/missing"],
    );

    await expect(coordinator.authorizeWorkspace("/root/child")).resolves.toBe(
      "/root/child",
    );
    await expect(coordinator.authorizedWorkspaceRoots()).resolves.toEqual([
      "/root",
    ]);
    await expect(
      coordinator.authorizeWorkspace("/outside"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_NOT_AUTHORIZED",
    });
  });

  it("keeps explicit nested roots and reports closest coverage", async () => {
    const coordinator = createCoordinator(
      createFileSystem({
        "/root": { canonical: "/root" },
        "/root/child": { canonical: "/root/child" },
      }),
      ["/root", "/root/child"],
    );
    await expect(
      coordinator.inspectWorkspaceRoots(["/root", "/root/child"]),
    ).resolves.toEqual([
      {
        configuredPath: "/root",
        canonicalPath: "/root",
        highRisk: false,
        status: "available",
      },
      {
        configuredPath: "/root/child",
        canonicalPath: "/root/child",
        coveredBy: "/root",
        highRisk: false,
        status: "available",
      },
    ]);
  });
  it("preserves the saved row when its canonical filesystem identity changes", async () => {
    const coordinator = createCoordinator(
      createFileSystem({
        "/saved": { canonical: "/replacement" },
        "/replacement": { canonical: "/replacement" },
      }),
      ["/saved"],
    );

    await expect(
      coordinator.replaceTaskRuntimeSettings({
        concurrentTaskCapacity: 4,
        workspaceRoots: ["/saved"],
      }),
    ).resolves.toEqual({
      concurrentTaskCapacity: 4,
      workspaceRoots: ["/saved"],
    });
    await expect(coordinator.authorizedWorkspaceRoots()).resolves.toEqual([]);
  });

  it("retries admission after a concurrent root removal commits", async () => {
    const candidateStarted = createDeferred();
    const releaseCandidate = createDeferred();
    const baseFileSystem = createFileSystem({
      "/root": { canonical: "/root" },
      "/root/child": { canonical: "/root/child" },
    });
    let shouldBlockCandidate = true;
    const coordinator = createCoordinator(
      {
        async realpath(path) {
          if (path === "/root/child" && shouldBlockCandidate) {
            shouldBlockCandidate = false;
            candidateStarted.resolve();
            await releaseCandidate.promise;
          }
          return baseFileSystem.realpath(path);
        },
        stat: baseFileSystem.stat,
      },
      ["/root"],
    );

    const admission = coordinator.authorizeWorkspace("/root/child");
    await candidateStarted.promise;
    await coordinator.replaceTaskRuntimeSettings({
      concurrentTaskCapacity: 3,
      workspaceRoots: [],
    });
    releaseCandidate.resolve();

    await expect(admission).rejects.toMatchObject({
      code: "WORKSPACE_NOT_AUTHORIZED",
    });
  });

  it("retries a stale save before preserving an unavailable saved row", async () => {
    const inspectionStarted = createDeferred();
    const releaseInspection = createDeferred();
    let shouldBlockInspection = true;
    const coordinator = createCoordinator(
      {
        async realpath(path) {
          if (path === "/missing" && shouldBlockInspection) {
            shouldBlockInspection = false;
            inspectionStarted.resolve();
            await releaseInspection.promise;
          }
          throw new Error("missing");
        },
        async stat() {
          throw new Error("missing");
        },
      },
      ["/missing"],
    );

    const staleSave = coordinator.replaceTaskRuntimeSettings({
      concurrentTaskCapacity: 4,
      workspaceRoots: ["/missing"],
    });
    await inspectionStarted.promise;
    await coordinator.replaceTaskRuntimeSettings({
      concurrentTaskCapacity: 3,
      workspaceRoots: [],
    });
    releaseInspection.resolve();

    await expect(staleSave).rejects.toMatchObject({
      code: "WORKSPACE_PATH_UNAVAILABLE",
    });
    expect(coordinator.readTaskRuntimeSettings()).toEqual({
      concurrentTaskCapacity: 3,
      workspaceRoots: [],
    });
  });
});
