import { describe, expect, it } from "vitest";

import {
  addCanonicalRoot,
  canonicalPathsEqual,
  findExactCanonicalRoot,
  isPathWithinRoot,
  isVolumeRoot,
} from "../../src/tasks/workspace-path-policy.js";

describe("workspace path policy", () => {
  it("uses Windows component and case semantics without prefix escapes", () => {
    expect(canonicalPathsEqual("C:\\Work", "c:\\work\\")).toBe(true);
    expect(isPathWithinRoot("C:\\Work", "c:\\work\\project")).toBe(true);
    expect(isPathWithinRoot("C:\\Work", "C:\\Workspace")).toBe(false);
    expect(isPathWithinRoot("C:\\Work", "D:\\Work")).toBe(false);
    expect(findExactCanonicalRoot(["C:\\Work"], "c:\\work")).toBe("C:\\Work");
  });

  it("detects drive and UNC share roots", () => {
    expect(isVolumeRoot("C:\\")).toBe(true);
    expect(isVolumeRoot("C:\\code")).toBe(false);
    expect(isVolumeRoot("\\\\server\\share\\")).toBe(true);
    expect(isVolumeRoot("\\\\server\\share\\project")).toBe(false);
  });

  it("keeps a minimal non-overlapping root set", () => {
    const covered = addCanonicalRoot(["C:\\work"], "C:\\work\\child");
    expect(covered).toEqual({
      coveringRoot: "C:\\work",
      kind: "already-covered",
      roots: ["C:\\work"],
    });

    const parent = addCanonicalRoot(
      ["C:\\work\\a", "D:\\independent", "C:\\work\\b"],
      "C:\\work",
    );
    expect(parent).toEqual({
      kind: "added",
      removedRedundantRoots: ["C:\\work\\a", "C:\\work\\b"],
      roots: ["D:\\independent", "C:\\work"],
    });
  });
});
