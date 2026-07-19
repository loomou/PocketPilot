import type { SettingsRepository } from "../storage/settings-repository.js";
import {
  readTaskRuntimeSettings,
  type TaskRuntimeSettings,
  taskRuntimeSettingsSchema,
  writeTaskRuntimeSettings,
} from "./settings.js";
import {
  canonicalizeExistingDirectory,
  canonicalPathsEqual,
  findCanonicalDuplicate,
  findCoveringRoot,
  inspectSavedWorkspaceRoot,
  isPathWithinRoot,
  isVolumeRoot,
  type WorkspacePathFileSystem,
} from "./workspace-path-policy.js";

export type WorkspaceAuthorizationErrorCode =
  | "WORKSPACE_PATH_INVALID"
  | "WORKSPACE_PATH_UNAVAILABLE"
  | "WORKSPACE_PATH_NOT_DIRECTORY"
  | "WORKSPACE_ROOT_DUPLICATE"
  | "WORKSPACE_ROOT_HIGH_RISK_CONFIRMATION_REQUIRED"
  | "WORKSPACE_NOT_AUTHORIZED";

export class WorkspaceAuthorizationError extends Error {
  public constructor(
    public readonly code: WorkspaceAuthorizationErrorCode,
    public readonly statusCode: 403 | 422,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceAuthorizationError";
  }
}

export type WorkspaceRootInspection = {
  configuredPath: string;
  status: "available" | "unavailable";
  canonicalPath?: string;
  highRisk: boolean;
  coveredBy?: string;
};

export type ReplaceTaskRuntimeSettingsInput = TaskRuntimeSettings & {
  confirmedHighRiskRoots?: readonly string[];
};

export type WorkspaceAuthorizationCoordinatorOptions = {
  fileSystem?: WorkspacePathFileSystem;
  maxRetries?: number;
  strictSavedIdentity?: boolean;
  settingsRepository: SettingsRepository;
};

/**
 * Shared owner for task workspace identity, availability, and admission.
 * Filesystem work happens outside the serial lane; only the revision check and
 * final comparison/persistence are serialized.
 */
export class WorkspaceAuthorizationCoordinator {
  readonly #fileSystem: WorkspacePathFileSystem | undefined;
  readonly #maxRetries: number;
  readonly #settingsRepository: SettingsRepository;
  readonly #strictSavedIdentity: boolean;
  readonly #lane = new SerialExecutor();
  #revision = 0;

  public constructor(options: WorkspaceAuthorizationCoordinatorOptions) {
    this.#fileSystem = options.fileSystem;
    this.#maxRetries = Math.max(1, options.maxRetries ?? 5);
    this.#settingsRepository = options.settingsRepository;
    this.#strictSavedIdentity = options.strictSavedIdentity ?? true;
  }

  public get revision(): number {
    return this.#revision;
  }

  public readTaskRuntimeSettings(): TaskRuntimeSettings {
    return readTaskRuntimeSettings(this.#settingsRepository);
  }

  public async authorizedWorkspaceRoots(): Promise<readonly string[]> {
    const snapshot = this.snapshot();
    const available: string[] = [];
    for (const configuredPath of snapshot.settings.workspaceRoots) {
      const inspected = await inspectSavedWorkspaceRoot(
        configuredPath,
        this.savedRootOptions(),
      );
      if (
        inspected.status === "available" &&
        inspected.canonicalPath !== undefined
      ) {
        available.push(inspected.canonicalPath);
      }
    }
    return available;
  }

  public async inspectWorkspaceRoots(
    paths: readonly string[],
  ): Promise<WorkspaceRootInspection[]> {
    const savedRoots = this.snapshot().settings.workspaceRoots;
    const inspected = await Promise.all(
      paths.map((configuredPath) =>
        inspectSavedWorkspaceRoot(configuredPath, {
          ...this.pathFileSystemOptions(),
          strictSavedIdentity:
            this.#strictSavedIdentity &&
            savedRoots.some((savedRoot) =>
              canonicalPathsEqual(savedRoot, configuredPath),
            ),
        }),
      ),
    );
    const available = inspected.flatMap((entry) =>
      entry.status === "available" && entry.canonicalPath !== undefined
        ? [entry.canonicalPath]
        : [],
    );
    return inspected.map((entry) => {
      const canonicalPath = entry.canonicalPath;
      const otherRoots = available.filter(
        (candidate) =>
          canonicalPath === undefined ||
          !canonicalPathsEqual(candidate, canonicalPath),
      );
      const coveringRoot =
        canonicalPath === undefined
          ? undefined
          : findCoveringRoot(canonicalPath, otherRoots);
      return {
        configuredPath: entry.path,
        ...(canonicalPath === undefined ? {} : { canonicalPath }),
        ...(coveringRoot === undefined ? {} : { coveredBy: coveringRoot }),
        highRisk:
          canonicalPath === undefined
            ? isVolumeRoot(entry.path)
            : isVolumeRoot(canonicalPath),
        status: entry.status,
      };
    });
  }

  public async authorizeWorkspace(requestedPath: string): Promise<string> {
    for (let attempt = 0; attempt < this.#maxRetries; attempt += 1) {
      const snapshot = this.snapshot();
      let canonicalCandidate: string;
      try {
        canonicalCandidate = await canonicalizeExistingDirectory(
          requestedPath,
          {
            ...this.pathFileSystemOptions(),
            requireAbsolute: true,
          },
        );
      } catch {
        throw new WorkspaceAuthorizationError(
          "WORKSPACE_NOT_AUTHORIZED",
          403,
          "The requested working directory is not an authorized workspace.",
        );
      }
      const availableRoots = await this.availableRoots(
        snapshot.settings.workspaceRoots,
      );
      const admitted = await this.#lane.run(() => {
        if (snapshot.revision !== this.#revision) {
          return undefined;
        }
        return availableRoots.some((root) =>
          isPathWithinRoot(root, canonicalCandidate),
        )
          ? canonicalCandidate
          : null;
      });
      if (admitted === undefined) {
        continue;
      }
      if (admitted === null) {
        throw new WorkspaceAuthorizationError(
          "WORKSPACE_NOT_AUTHORIZED",
          403,
          "The requested working directory is not an authorized workspace.",
        );
      }
      return admitted;
    }
    throw new WorkspaceAuthorizationError(
      "WORKSPACE_NOT_AUTHORIZED",
      403,
      "The workspace authorization policy changed while the request was being admitted.",
    );
  }

  public async isPathWithinWorkspace(
    workspaceRoot: string,
    candidatePath: string,
  ): Promise<boolean> {
    try {
      const canonicalCandidate = await canonicalizeExistingDirectory(
        candidatePath,
        {
          ...this.pathFileSystemOptions(),
          requireAbsolute: true,
        },
      );
      return isPathWithinRoot(workspaceRoot, canonicalCandidate);
    } catch {
      return false;
    }
  }
  public async replaceTaskRuntimeSettings(
    input: ReplaceTaskRuntimeSettingsInput,
  ): Promise<TaskRuntimeSettings> {
    const parsed = taskRuntimeSettingsSchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkspaceAuthorizationError(
        "WORKSPACE_PATH_INVALID",
        422,
        "The task runtime settings are invalid.",
      );
    }
    const requested = parsed.data.workspaceRoots;
    const confirmedHighRiskRoots = input.confirmedHighRiskRoots ?? [];

    for (let attempt = 0; attempt < this.#maxRetries; attempt += 1) {
      const snapshot = this.snapshot();
      const nextRoots = await this.validateRequestedRoots(
        requested,
        snapshot.settings.workspaceRoots,
        confirmedHighRiskRoots,
      );
      const committed = await this.#lane.run(() => {
        if (snapshot.revision !== this.#revision) {
          return undefined;
        }
        const nextSettings = {
          concurrentTaskCapacity: parsed.data.concurrentTaskCapacity,
          workspaceRoots: nextRoots,
        } satisfies TaskRuntimeSettings;
        writeTaskRuntimeSettings(this.#settingsRepository, nextSettings);
        this.#revision += 1;
        return nextSettings;
      });
      if (committed !== undefined) {
        return committed;
      }
    }
    throw new WorkspaceAuthorizationError(
      "WORKSPACE_PATH_UNAVAILABLE",
      422,
      "The workspace authorization policy changed while saving. Please retry.",
    );
  }

  private pathFileSystemOptions(): { fileSystem?: WorkspacePathFileSystem } {
    return this.#fileSystem === undefined
      ? {}
      : { fileSystem: this.#fileSystem };
  }

  private savedRootOptions(): {
    fileSystem?: WorkspacePathFileSystem;
    strictSavedIdentity: boolean;
  } {
    return {
      ...(this.#fileSystem === undefined
        ? {}
        : { fileSystem: this.#fileSystem }),
      strictSavedIdentity: this.#strictSavedIdentity,
    };
  }
  private snapshot(): { revision: number; settings: TaskRuntimeSettings } {
    return {
      revision: this.#revision,
      settings: this.readTaskRuntimeSettings(),
    };
  }

  private async availableRoots(roots: readonly string[]): Promise<string[]> {
    const inspected = await Promise.all(
      roots.map((root) =>
        inspectSavedWorkspaceRoot(root, this.savedRootOptions()),
      ),
    );
    return inspected.flatMap((entry) =>
      entry.status === "available" && entry.canonicalPath !== undefined
        ? [entry.canonicalPath]
        : [],
    );
  }

  private async validateRequestedRoots(
    requestedRoots: readonly string[],
    savedRoots: readonly string[],
    confirmedHighRiskRoots: readonly string[],
  ): Promise<string[]> {
    const nextRoots: string[] = [];
    for (const requestedRoot of requestedRoots) {
      const previouslySaved = savedRoots.find((savedRoot) =>
        canonicalPathsEqual(savedRoot, requestedRoot),
      );
      let canonicalRoot: string;

      if (previouslySaved !== undefined) {
        const inspected = await inspectSavedWorkspaceRoot(
          previouslySaved,
          this.savedRootOptions(),
        );
        if (
          inspected.status === "unavailable" ||
          inspected.canonicalPath === undefined
        ) {
          // Preserve the exact saved row, including an identity-changed or
          // temporarily inaccessible path, rather than silently rewriting it.
          nextRoots.push(previouslySaved);
          continue;
        }
        canonicalRoot = inspected.canonicalPath;
      } else {
        try {
          canonicalRoot = await canonicalizeExistingDirectory(requestedRoot, {
            ...this.pathFileSystemOptions(),
            requireAbsolute: true,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("not a directory")
          ) {
            throw new WorkspaceAuthorizationError(
              "WORKSPACE_PATH_NOT_DIRECTORY",
              422,
              "A configured workspace root must be a directory.",
            );
          }
          throw new WorkspaceAuthorizationError(
            "WORKSPACE_PATH_UNAVAILABLE",
            422,
            "A newly added workspace root must be an available directory.",
          );
        }
      }

      if (findCanonicalDuplicate([...nextRoots, canonicalRoot]) !== undefined) {
        throw new WorkspaceAuthorizationError(
          "WORKSPACE_ROOT_DUPLICATE",
          422,
          "The configured workspace roots contain a duplicate directory.",
        );
      }
      if (
        isVolumeRoot(canonicalRoot) &&
        previouslySaved === undefined &&
        !confirmedHighRiskRoots.some((confirmed) =>
          canonicalPathsEqual(confirmed, canonicalRoot),
        )
      ) {
        throw new WorkspaceAuthorizationError(
          "WORKSPACE_ROOT_HIGH_RISK_CONFIRMATION_REQUIRED",
          422,
          "A filesystem or volume root requires explicit confirmation.",
        );
      }
      nextRoots.push(canonicalRoot);
    }
    return nextRoots;
  }
}

class SerialExecutor {
  #tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
