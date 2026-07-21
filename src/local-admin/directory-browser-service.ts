import { readdir, realpath, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, parse, posix, win32 } from "node:path";

import {
  canonicalizeExistingDirectory,
  isAbsolutePath,
  WorkspacePathError,
  type WorkspacePathFileSystem,
} from "../tasks/workspace-path-policy.js";

export type DirectoryBrowserEntry = {
  name: string;
  path: string;
  accessible: boolean;
  root: boolean;
};

export type DirectoryBrowseResult = {
  currentPath: string | null;
  parentPath: string | null;
  entries: DirectoryBrowserEntry[];
  truncated: boolean;
};

export type DirectoryBrowserFileSystem = WorkspacePathFileSystem & {
  readdir(path: string): Promise<readonly DirectoryBrowserDirent[]>;
  listRoots(): Promise<readonly string[]>;
  homeDirectory(): string;
};

export type DirectoryBrowserDirent = {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink?(): boolean;
};

export class DirectoryBrowserError extends Error {
  public constructor(
    public readonly code:
      | "DIRECTORY_PATH_INVALID"
      | "DIRECTORY_NOT_FOUND"
      | "DIRECTORY_NOT_ACCESSIBLE"
      | "DIRECTORY_LISTING_TOO_LARGE",
    message: string,
    public readonly statusCode: 400 | 404 | 422 = 422,
  ) {
    super(message);
    this.name = "DirectoryBrowserError";
  }
}

export type DirectoryBrowserServiceOptions = {
  fileSystem?: DirectoryBrowserFileSystem;
  maxEntries?: number;
};

const nodeDirectoryBrowserFileSystem: DirectoryBrowserFileSystem = {
  async realpath(path) {
    return realpath(path);
  },
  async stat(path) {
    return stat(path);
  },
  async readdir(path) {
    return readdir(path, { withFileTypes: true });
  },
  async listRoots() {
    if (platform() !== "win32") {
      return ["/"];
    }
    const roots: string[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      try {
        const candidate = await realpath(root);
        if ((await stat(candidate)).isDirectory()) {
          roots.push(candidate);
        }
      } catch {
        // An absent or inaccessible drive is not a navigable root.
      }
    }
    return roots;
  },
  homeDirectory: homedir,
};

export class DirectoryBrowserService {
  readonly #fileSystem: DirectoryBrowserFileSystem;
  readonly #maxEntries: number;

  public constructor(options: DirectoryBrowserServiceOptions = {}) {
    this.#fileSystem = options.fileSystem ?? nodeDirectoryBrowserFileSystem;
    this.#maxEntries = Math.max(1, options.maxEntries ?? 500);
  }

  public async browse(path?: string): Promise<DirectoryBrowseResult> {
    if (path === undefined) {
      return this.browseVirtualRoots();
    }
    if (!isAbsolutePath(path)) {
      throw new DirectoryBrowserError(
        "DIRECTORY_PATH_INVALID",
        "The directory path must be absolute.",
        400,
      );
    }

    let currentPath: string;
    try {
      currentPath = await canonicalizeExistingDirectory(path, {
        fileSystem: this.#fileSystem,
        requireAbsolute: true,
      });
    } catch (error) {
      const pathError =
        error instanceof WorkspacePathError ? error.code : undefined;
      throw new DirectoryBrowserError(
        pathError === "INVALID_ABSOLUTE_PATH" ||
          pathError === "PATH_NOT_DIRECTORY"
          ? "DIRECTORY_PATH_INVALID"
          : "DIRECTORY_NOT_ACCESSIBLE",
        "The directory is missing, inaccessible, or not a directory.",
        422,
      );
    }

    let entries: readonly DirectoryBrowserDirent[];
    try {
      entries = await this.#fileSystem.readdir(currentPath);
    } catch {
      throw new DirectoryBrowserError(
        "DIRECTORY_NOT_ACCESSIBLE",
        "The directory cannot be listed.",
        422,
      );
    }

    const directories: DirectoryBrowserEntry[] = [];
    for (const entry of entries) {
      const candidate = joinPath(currentPath, entry.name);
      let isDirectory = entry.isDirectory();
      let accessible = true;
      if (!isDirectory) {
        try {
          isDirectory = (await this.#fileSystem.stat(candidate)).isDirectory();
        } catch {
          isDirectory = false;
          accessible = false;
        }
      }
      if (!isDirectory) {
        continue;
      }
      directories.push({
        accessible,
        name: entry.name,
        path: candidate,
        root: false,
      });
    }
    directories.sort(compareEntries);
    const truncated = directories.length > this.#maxEntries;
    return {
      currentPath,
      entries: directories.slice(0, this.#maxEntries),
      parentPath: isFilesystemRoot(currentPath)
        ? null
        : parentPath(currentPath),
      truncated,
    };
  }

  private async browseVirtualRoots(): Promise<DirectoryBrowseResult> {
    const roots = new Map<string, DirectoryBrowserEntry>();
    const home = this.#fileSystem.homeDirectory();
    for (const root of [...(await this.#fileSystem.listRoots()), home]) {
      try {
        const canonical = await canonicalizeExistingDirectory(root, {
          fileSystem: this.#fileSystem,
          requireAbsolute: true,
        });
        roots.set(canonical.toLowerCase(), {
          accessible: true,
          name: rootName(canonical),
          path: canonical,
          root: true,
        });
      } catch {
        // Virtual shortcuts only expose paths that are currently accessible.
      }
    }
    return {
      currentPath: null,
      entries: [...roots.values()].sort(compareEntries),
      parentPath: null,
      truncated: false,
    };
  }
}

function compareEntries(
  left: DirectoryBrowserEntry,
  right: DirectoryBrowserEntry,
): number {
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
}

function joinPath(base: string, child: string): string {
  return isWindowsPath(base)
    ? win32.join(base, child)
    : posix.join(base, child);
}

function parentPath(path: string): string | null {
  const parent = isWindowsPath(path) ? win32.dirname(path) : dirname(path);
  return parent === path ? null : parent;
}

function isFilesystemRoot(path: string): boolean {
  if (isWindowsPath(path)) {
    return win32.parse(path).root === path;
  }
  return path === "/";
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\");
}

function rootName(path: string): string {
  if (isWindowsPath(path)) {
    const parsed = win32.parse(path);
    return parsed.root === path ? path : parsed.base;
  }
  if (path === "/") {
    return "/";
  }
  return parse(path).base;
}
