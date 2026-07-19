import { describe, expect, it } from "vitest";

import {
  addCanonicalRoot,
  canonicalizeExistingDirectory,
  canonicalPathKey,
  canonicalPathsEqual,
  findCanonicalDuplicate,
  findCoveringRoot,
  findExactCanonicalRoot,
  inspectSavedWorkspaceRoot,
  isPathWithinRoot,
  isVolumeRoot,
  type WorkspacePathFileSystem,
} from "../../src/tasks/workspace-path-policy.js";

function fakeFileSystem(options: {
  directories?: readonly string[];
  realpaths?: Readonly<Record<string, string>>;
}): WorkspacePathFileSystem {
  const directories = new Set(options.directories ?? []);
  return {
    async realpath(path) {
      const resolved = options.realpaths?.[path];
      if (resolved === undefined) {
        throw new Error("missing");
      }
      return resolved;
    },
    async stat(path) {
      return { isDirectory: () => directories.has(path) };
    },
  };
}

describe("workspace path policy", () => {
  it("keeps Windows root semantics and minimal root sets", () => {
    expect(canonicalPathsEqual("C:\\Work", "c:\\work\\")).toBe(true);
    expect(isPathWithinRoot("C:\\Work", "c:\\work\\project")).toBe(true);
    expect(isPathWithinRoot("C:\\Work", "C:\\Workspace")).toBe(false);
    expect(isPathWithinRoot("C:\\Work", "D:\\Work")).toBe(false);
    expect(findExactCanonicalRoot(["C:\\Work"], "c:\\work")).toBe("C:\\Work");

    expect(addCanonicalRoot(["C:\\work"], "C:\\work\\child")).toEqual({
      coveringRoot: "C:\\work",
      kind: "already-covered",
      roots: ["C:\\work"],
    });
    expect(
      addCanonicalRoot(
        ["C:\\work\\a", "D:\\independent", "C:\\work\\b"],
        "C:\\work",
      ),
    ).toEqual({
      kind: "added",
      removedRedundantRoots: ["C:\\work\\a", "C:\\work\\b"],
      roots: ["D:\\independent", "C:\\work"],
    });
  });
  it("canonicalizes only existing absolute directories", async () => {
    const fileSystem = fakeFileSystem({
      directories: ["/srv/workspace"],
      realpaths: { "/srv/link": "/srv/workspace", "/srv/file": "/srv/file" },
    });

    await expect(
      canonicalizeExistingDirectory("relative", { fileSystem }),
    ).rejects.toMatchObject({ code: "INVALID_ABSOLUTE_PATH" });
    await expect(
      canonicalizeExistingDirectory("/srv/missing", { fileSystem }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ACCESSIBLE" });
    await expect(
      canonicalizeExistingDirectory("/srv/file", { fileSystem }),
    ).rejects.toMatchObject({ code: "PATH_NOT_DIRECTORY" });
    await expect(
      canonicalizeExistingDirectory("/srv/link", { fileSystem }),
    ).resolves.toBe("/srv/workspace");
  });

  it("uses case-insensitive Windows identity and case-sensitive POSIX identity", () => {
    expect(canonicalPathKey("C:\\Work\\Project\\")).toBe(
      canonicalPathKey("c:/work/project"),
    );
    expect(canonicalPathsEqual("/Work", "/work")).toBe(false);
    expect(
      canonicalPathsEqual("\\\\Server\\Share\\Root", "//server/share/root"),
    ).toBe(true);
  });

  it("checks containment by path components for POSIX and Windows paths", () => {
    expect(isPathWithinRoot("/work", "/work")).toBe(true);
    expect(isPathWithinRoot("/work", "/work/project")).toBe(true);
    expect(isPathWithinRoot("/work", "/workspace")).toBe(false);
    expect(isPathWithinRoot("C:\\Work", "c:\\work\\Project")).toBe(true);
    expect(isPathWithinRoot("C:\\Work", "C:\\Workspace")).toBe(false);
    expect(
      isPathWithinRoot("\\\\server\\share", "\\\\SERVER\\SHARE\\folder"),
    ).toBe(true);
  });

  it("recognizes filesystem and share roots without treating normal directories as roots", () => {
    expect(isVolumeRoot("/")).toBe(true);
    expect(isVolumeRoot("C:\\")).toBe(true);
    expect(isVolumeRoot("\\\\server\\share\\")).toBe(true);
    expect(isVolumeRoot("/srv")).toBe(false);
    expect(isVolumeRoot("C:\\work")).toBe(false);
  });

  it("detects only exact canonical duplicates and preserves nested roots", () => {
    expect(
      findCanonicalDuplicate(["C:\\Work", "c:/work", "C:\\Work\\child"]),
    ).toEqual({ duplicateIndex: 1, originalIndex: 0 });
    expect(findCanonicalDuplicate(["/work", "/work/child"])).toBeUndefined();
  });

  it("returns the closest covering root", () => {
    expect(
      findCoveringRoot("/work/project/src", [
        "/work",
        "/work/project",
        "/other",
      ]),
    ).toBe("/work/project");
    expect(findCoveringRoot("/outside", ["/work"])).toBeUndefined();
  });

  it("marks saved roots unavailable when their filesystem identity changes", async () => {
    const availableFileSystem = fakeFileSystem({
      directories: ["c:\\WORK"],
      realpaths: { "C:\\Work": "c:\\WORK" },
    });
    await expect(
      inspectSavedWorkspaceRoot("C:\\Work", {
        fileSystem: availableFileSystem,
      }),
    ).resolves.toMatchObject({ status: "available" });

    const retargetedFileSystem = fakeFileSystem({
      directories: ["/other"],
      realpaths: { "/saved": "/other" },
    });
    await expect(
      inspectSavedWorkspaceRoot("/saved", { fileSystem: retargetedFileSystem }),
    ).resolves.toEqual({
      path: "/saved",
      reason: "identity-changed",
      status: "unavailable",
    });
  });
});
