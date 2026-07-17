import { randomUUID } from "node:crypto";

import {
  isVolumeRoot,
  nodeWorkspaceDirectoryResolver,
  type WorkspaceDirectoryResolver,
} from "../tasks/workspace-path-policy.js";
import { LocalAdminError } from "./errors.js";
import type { DirectoryPicker } from "./windows-directory-picker.js";

const DEFAULT_SELECTION_LIFETIME_MILLISECONDS = 2 * 60 * 1000;
const MAX_RETAINED_SELECTIONS = 32;

export type SelectedDirectory = {
  expiresAt: number;
  path: string;
  selectionId: string;
  volumeRoot: boolean;
};

export type DirectorySelectionResult =
  | { status: "cancelled" }
  | ({ status: "selected" } & SelectedDirectory);

export type DirectorySelectionServiceOptions = {
  directoryResolver?: WorkspaceDirectoryResolver;
  now?: () => number;
  selectionLifetimeMilliseconds?: number;
};

/** Owns picker results so the add API never accepts an arbitrary local path. */
export class DirectorySelectionService {
  readonly #directoryResolver: WorkspaceDirectoryResolver;
  readonly #now: () => number;
  readonly #selectionLifetimeMilliseconds: number;
  readonly #selections = new Map<string, SelectedDirectory>();

  public constructor(
    private readonly picker: DirectoryPicker,
    options: DirectorySelectionServiceOptions = {},
  ) {
    this.#directoryResolver =
      options.directoryResolver ?? nodeWorkspaceDirectoryResolver;
    this.#now = options.now ?? Date.now;
    this.#selectionLifetimeMilliseconds =
      options.selectionLifetimeMilliseconds ??
      DEFAULT_SELECTION_LIFETIME_MILLISECONDS;
  }

  public async pick(signal?: AbortSignal): Promise<DirectorySelectionResult> {
    const result = await this.picker.pick(signal);
    if (result.status === "cancelled") {
      return result;
    }

    let path: string;
    try {
      path = await this.#directoryResolver.canonicalizeDirectory(result.path);
    } catch {
      throw new LocalAdminError(
        "AUTHORIZED_DIRECTORY_INVALID",
        422,
        "The selected path is not an accessible local directory.",
      );
    }

    const now = this.#now();
    this.prune(now);
    if (this.#selections.size >= MAX_RETAINED_SELECTIONS) {
      const oldestSelectionId = this.#selections.keys().next().value;
      if (typeof oldestSelectionId === "string") {
        this.#selections.delete(oldestSelectionId);
      }
    }
    const selection: SelectedDirectory = {
      expiresAt: now + this.#selectionLifetimeMilliseconds,
      path,
      selectionId: randomUUID(),
      volumeRoot: isVolumeRoot(path),
    };
    this.#selections.set(selection.selectionId, selection);
    return { ...selection, status: "selected" };
  }

  public consume(selectionId: string): SelectedDirectory {
    const now = this.#now();
    this.prune(now);
    const selection = this.#selections.get(selectionId);
    if (selection === undefined) {
      throw selectionUnavailableError();
    }
    this.#selections.delete(selectionId);
    return selection;
  }

  private prune(now: number): void {
    for (const [selectionId, selection] of this.#selections) {
      if (selection.expiresAt <= now) {
        this.#selections.delete(selectionId);
      }
    }
  }
}

function selectionUnavailableError(): LocalAdminError {
  return new LocalAdminError(
    "DIRECTORY_SELECTION_UNAVAILABLE",
    409,
    "The directory selection expired or has already been used.",
  );
}
