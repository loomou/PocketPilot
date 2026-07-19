import { realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, resolve, win32 } from "node:path";

export type WorkspaceDirectoryResolver = {
  canonicalizeDirectory(path: string): Promise<string>;
};

export type AddCanonicalRootResult =
  | { coveringRoot: string; kind: "already-covered"; roots: string[] }
  | { kind: "added"; removedRedundantRoots: string[]; roots: string[] };

export type WorkspacePathFileSystem = {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
};

export type WorkspacePathErrorCode =
  | "INVALID_ABSOLUTE_PATH"
  | "PATH_NOT_FOUND"
  | "PATH_NOT_ACCESSIBLE"
  | "PATH_NOT_DIRECTORY"
  | "PATH_IDENTITY_CHANGED";

export class WorkspacePathError extends Error {
  public constructor(
    public readonly code: WorkspacePathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export type SavedWorkspaceRootInspection = {
  path: string;
  status: "available" | "unavailable";
  canonicalPath?: string;
  reason?: "missing" | "inaccessible" | "not-directory" | "identity-changed";
};

const nodeWorkspacePathFileSystem: WorkspacePathFileSystem = {
  realpath,
  stat,
};

/**
 * Resolves an existing directory to its filesystem identity. The realpath
 * result is the only path that should be persisted for newly authorized roots.
 */
export async function canonicalizeExistingDirectory(
  input: string,
  options: {
    fileSystem?: WorkspacePathFileSystem;
    requireAbsolute?: boolean;
  } = {},
): Promise<string> {
  const value = input.trim();
  const requireAbsolute = options.requireAbsolute ?? true;
  if (value.length === 0 || (requireAbsolute && !isAbsolutePath(value))) {
    throw new WorkspacePathError(
      "INVALID_ABSOLUTE_PATH",
      "The workspace path must be an absolute path.",
    );
  }

  const fileSystem = options.fileSystem ?? nodeWorkspacePathFileSystem;
  const candidate = requireAbsolute ? value : resolve(value);
  let canonicalPath: string;
  try {
    canonicalPath = await fileSystem.realpath(candidate);
  } catch {
    throw new WorkspacePathError(
      "PATH_NOT_ACCESSIBLE",
      "The workspace path is missing or inaccessible.",
    );
  }

  let directory: { isDirectory(): boolean };
  try {
    directory = await fileSystem.stat(canonicalPath);
  } catch {
    throw new WorkspacePathError(
      "PATH_NOT_ACCESSIBLE",
      "The workspace path is missing or inaccessible.",
    );
  }
  if (!directory.isDirectory()) {
    throw new WorkspacePathError(
      "PATH_NOT_DIRECTORY",
      "The workspace path is not a directory.",
    );
  }
  return canonicalPath;
}

/** Returns a stable identity key for a canonical path. */
export function canonicalPathKey(path: string): string {
  const normalized = normalizePath(path);
  return isWindowsPath(path) ? normalized.toLowerCase() : normalized;
}

export function canonicalPathsEqual(left: string, right: string): boolean {
  return canonicalPathKey(left) === canonicalPathKey(right);
}

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

export function addCanonicalRoot(
  existingRoots: readonly string[],
  selectedRoot: string,
): AddCanonicalRootResult {
  const coveringRoot = existingRoots.find((root) =>
    isPathWithinRoot(root, selectedRoot),
  );
  if (coveringRoot !== undefined) {
    return { coveringRoot, kind: "already-covered", roots: [...existingRoots] };
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

/**
 * Checks containment using path components instead of string prefixes.
 * Equality is considered contained so a root authorizes itself.
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const rootWindows = isWindowsPath(root);
  if (rootWindows !== isWindowsPath(candidate)) {
    return false;
  }
  const pathModule = rootWindows ? win32 : posix;
  const normalizedRoot = pathModule.normalize(root);
  const normalizedCandidate = pathModule.normalize(candidate);
  const relativePath = pathModule.relative(normalizedRoot, normalizedCandidate);
  return (
    relativePath === "" ||
    (!pathModule.isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${pathModule.sep}`))
  );
}

export function findCanonicalDuplicate(
  paths: readonly string[],
): { duplicateIndex: number; originalIndex: number } | undefined {
  const seen = new Map<string, number>();
  for (const [index, path] of paths.entries()) {
    const key = canonicalPathKey(path);
    const originalIndex = seen.get(key);
    if (originalIndex !== undefined) {
      return { duplicateIndex: index, originalIndex };
    }
    seen.set(key, index);
  }
  return undefined;
}

export function hasCanonicalDuplicates(paths: readonly string[]): boolean {
  return findCanonicalDuplicate(paths) !== undefined;
}
export function isVolumeRoot(path: string): boolean {
  const normalized = normalizePath(path);
  if (isWindowsPath(path)) {
    return win32.parse(normalized).root === normalized;
  }
  return normalized === "/";
}

export function findCoveringRoot(
  candidate: string,
  roots: readonly string[],
): string | undefined {
  return roots
    .filter((root) => isPathWithinRoot(root, candidate))
    .sort((left, right) => {
      return canonicalPathKey(right).length - canonicalPathKey(left).length;
    })[0];
}

export const closestCoveringRoot = findCoveringRoot;

export function isRootCoveredBy(
  candidate: string,
  roots: readonly string[],
): boolean {
  return findCoveringRoot(candidate, roots) !== undefined;
}

/**
 * Inspects a previously saved root without silently following a replacement
 * symlink/junction. A saved row is available only when realpath(savedPath)
 * still has the same canonical identity as the saved path itself.
 */
export async function inspectSavedWorkspaceRoot(
  savedPath: string,
  options: {
    cwd?: string;
    fileSystem?: WorkspacePathFileSystem;
    strictSavedIdentity?: boolean;
  } = {},
): Promise<SavedWorkspaceRootInspection> {
  const fileSystem = options.fileSystem ?? nodeWorkspacePathFileSystem;
  const candidate = isAbsolutePath(savedPath)
    ? savedPath
    : resolve(options.cwd ?? process.cwd(), savedPath);
  const savedIdentity = canonicalPathKey(candidate);

  let resolvedPath: string;
  try {
    resolvedPath = await fileSystem.realpath(candidate);
  } catch {
    return { path: savedPath, reason: "inaccessible", status: "unavailable" };
  }

  let directory: { isDirectory(): boolean };
  try {
    directory = await fileSystem.stat(resolvedPath);
  } catch {
    return { path: savedPath, reason: "inaccessible", status: "unavailable" };
  }
  if (!directory.isDirectory()) {
    return { path: savedPath, reason: "not-directory", status: "unavailable" };
  }
  if (
    options.strictSavedIdentity !== false &&
    canonicalPathKey(resolvedPath) !== savedIdentity
  ) {
    return {
      path: savedPath,
      reason: "identity-changed",
      status: "unavailable",
    };
  }
  return { canonicalPath: resolvedPath, path: savedPath, status: "available" };
}

export function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || isWindowsPath(path);
}

function isWindowsPath(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.startsWith("\\\\") ||
    /^\/\/[^/\\]+[/\\][^/\\]+/u.test(path)
  );
}

function normalizePath(path: string): string {
  if (isWindowsPath(path)) {
    const normalized = win32.normalize(path).replaceAll("/", "\\");
    const root = win32.parse(normalized).root;
    if (normalized !== root) {
      return normalized.replace(/[\\]+$/u, "");
    }
    return normalized;
  }
  return posix.normalize(path);
}
