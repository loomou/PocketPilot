import { describe, expect, it } from "vitest";

import {
  type DirectoryBrowserFileSystem,
  DirectoryBrowserService,
} from "../../src/local-admin/directory-browser-service.js";

function createFileSystem(): DirectoryBrowserFileSystem {
  const directories = new Set([
    "/",
    "/home/operator",
    "/work",
    "/work/alpha",
    "/work/beta",
  ]);
  const entries: Record<string, Array<{ name: string; directory: boolean }>> = {
    "/work": [
      { name: "z-file.txt", directory: false },
      { name: "beta", directory: true },
      { name: "alpha", directory: true },
    ],
  };
  return {
    async realpath(path) {
      if (!directories.has(path)) throw new Error("missing");
      return path;
    },
    async stat(path) {
      return { isDirectory: () => directories.has(path) };
    },
    async readdir(path) {
      return (entries[path] ?? []).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.directory,
      }));
    },
    async listRoots() {
      return ["/"];
    },
    homeDirectory() {
      return "/home/operator";
    },
  };
}

describe("DirectoryBrowserService", () => {
  it("provides virtual roots and canonical directory-only listings", async () => {
    const service = new DirectoryBrowserService({
      fileSystem: createFileSystem(),
    });
    await expect(service.browse()).resolves.toMatchObject({
      currentPath: null,
      parentPath: null,
      entries: [
        { name: "/", path: "/", root: true },
        { name: "operator", path: "/home/operator", root: true },
      ],
    });
    await expect(service.browse("/work")).resolves.toEqual({
      currentPath: "/work",
      parentPath: "/",
      entries: [
        { accessible: true, name: "alpha", path: "/work/alpha", root: false },
        { accessible: true, name: "beta", path: "/work/beta", root: false },
      ],
      truncated: false,
    });
  });

  it("rejects relative paths and bounds directory results", async () => {
    const fileSystem = createFileSystem();
    const service = new DirectoryBrowserService({ fileSystem, maxEntries: 1 });
    await expect(service.browse("work")).rejects.toMatchObject({
      code: "DIRECTORY_PATH_INVALID",
    });
    await expect(service.browse("/work")).resolves.toMatchObject({
      entries: [{ name: "alpha" }],
      truncated: true,
    });
  });
});
