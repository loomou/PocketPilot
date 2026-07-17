import { realpath, stat } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";

export type WorkspaceDirectoryResolver = {
  canonicalizeDirectory(path: string): Promise<string>;
};

export type AddCanonicalRootResult =
  | {
      coveringRoot: string;
      kind: "already-covered";
      roots: string[];
    }
  | {
      kind: "added";
      removedRedundantRoots: string[];
      roots: string[];
    };

export const nodeWorkspaceDirectoryResolver: WorkspaceDirectoryResolver = {
  async canonicalizeDirectory(path: string): Promise<string> {
    const canonicalPath = await realpath(resolve(path));
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
      throw new Error("The selected path is not a directory.");
    }
    return canonicalPath;
  },
};

/** Returns a stable identity for an already-canonical absolute path. */
export function canonicalPathKey(path: string): string {
  const pathApi = pathApiFor(path);
  const normalized = pathApi.normalize(path);
  const root = pathApi.parse(normalized).root;
  const withoutTrailingSeparators =
    normalized === root ? normalized : normalized.replace(/[\\/]+$/u, "");
  return usesWindowsSemantics(path)
    ? withoutTrailingSeparators.toLocaleLowerCase("en-US")
    : withoutTrailingSeparators;
}

export function canonicalPathsEqual(left: string, right: string): boolean {
  return canonicalPathKey(left) === canonicalPathKey(right);
}

/** Checks path containment on component boundaries, never by string prefix. */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  if (usesWindowsSemantics(root) !== usesWindowsSemantics(candidate)) {
    return false;
  }
  const pathApi = pathApiFor(root);
  const pathFromRoot = pathApi.relative(
    canonicalPathKey(root),
    canonicalPathKey(candidate),
  );
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(pathFromRoot))
  );
}

export function isVolumeRoot(path: string): boolean {
  const pathApi = pathApiFor(path);
  const root = pathApi.parse(path).root;
  return root.length > 0 && canonicalPathsEqual(path, root);
}

export function addCanonicalRoot(
  existingRoots: readonly string[],
  selectedRoot: string,
): AddCanonicalRootResult {
  const coveringRoot = existingRoots.find((root) =>
    isPathWithinRoot(root, selectedRoot),
  );
  if (coveringRoot !== undefined) {
    return {
      coveringRoot,
      kind: "already-covered",
      roots: [...existingRoots],
    };
  }

  const removedRedundantRoots = existingRoots.filter((root) =>
    isPathWithinRoot(selectedRoot, root),
  );
  const roots = existingRoots.filter(
    (root) => !removedRedundantRoots.includes(root),
  );
  roots.push(selectedRoot);
  return { kind: "added", removedRedundantRoots, roots };
}

export function findExactCanonicalRoot(
  roots: readonly string[],
  requestedRoot: string,
): string | undefined {
  return roots.find((root) => canonicalPathsEqual(root, requestedRoot));
}

function pathApiFor(path: string): typeof posix | typeof win32 {
  return usesWindowsSemantics(path) ? win32 : posix;
}

function usesWindowsSemantics(path: string): boolean {
  return (
    process.platform === "win32" ||
    /^[a-zA-Z]:[\\/]/u.test(path) ||
    /^\\\\/u.test(path)
  );
}
