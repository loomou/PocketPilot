import { randomUUID } from "node:crypto";

import type {
  EffortLevel,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentTaskController } from "../agent-providers/types.js";
import {
  createToolApprovalHandler,
  type PendingToolApproval,
  type SerializableCanUseToolRequest,
} from "../claude-sdk/permission-gate.js";
import {
  type ClaudeSdkInitialization,
  type ClaudeSdkSession,
  claudeAgentSdkProtocolVersion,
  type OpenClaudeSdkSessionOptions,
  openClaudeSdkSession,
  pinnedEffortLevels,
  pinnedPermissionModes,
} from "../claude-sdk/session.js";
import {
  type ClaudeSessionCatalog,
  installedClaudeSessionCatalog,
} from "../claude-sdk/session-catalog.js";
import { logEvents } from "../logging/events.js";
import {
  noopLogger,
  type PocketPilotLogger,
  safeErrorFields,
} from "../logging/logger.js";
import type { StorageDatabase } from "../storage/database.js";
import type { SettingsRepository } from "../storage/settings-repository.js";
import { TaskError } from "./errors.js";
import type {
  ProviderApprovalRequest,
  ProviderTaskRuntime,
} from "./provider-task-runtime.js";
import { readTaskRuntimeSettings } from "./settings.js";
import type { TaskEventSink } from "./task-events.js";
import {
  type TaskOperationLease,
  TaskOperationScheduler,
} from "./task-operation-scheduler.js";
import { TaskRepository } from "./task-repository.js";
import type {
  TaskBoundOperationResult,
  TaskOperationAction,
  TaskOperationResult,
  TaskSnapshot,
} from "./task-types.js";
import {
  WorkspaceAuthorizationCoordinator,
  WorkspaceAuthorizationError,
} from "./workspace-authorization-coordinator.js";
import {
  addCanonicalRoot,
  canonicalPathsEqual,
  isPathWithinRoot,
  isVolumeRoot,
  nodeWorkspaceDirectoryResolver,
  type WorkspaceDirectoryResolver,
} from "./workspace-path-policy.js";

const OPERATION_RESULT_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1000;

const operationIdentitySchema = z.object({
  deviceId: z.uuid(),
  operationId: z.uuid(),
});

const createTaskInputSchema = operationIdentitySchema.extend({
  initialCwd: z.string().trim().min(1).max(4_096),
  model: z.string().trim().min(1).max(256).optional(),
  permissionMode: z.string().trim().min(1).max(128),
  workspaceRiskAccepted: z.boolean(),
});

const sessionOperationInputSchema = operationIdentitySchema.extend({
  workspace: z.string().trim().min(1).max(4_096),
  workspaceRiskAccepted: z.boolean(),
});

const attachClaudeSessionInputSchema = sessionOperationInputSchema.extend({
  sessionId: z.string().trim().min(1).max(256),
});

const listClaudeSessionsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  workspace: z.string().trim().min(1).max(4_096),
});

const readClaudeSessionHistoryInputSchema = z.object({
  beforeUuid: z.string().trim().min(1).max(256).optional(),
  includeSystemMessages: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(50),
  sessionId: z.string().trim().min(1).max(256),
  workspace: z.string().trim().min(1).max(4_096),
});

const taskIdSchema = z.uuid();
const deviceIdSchema = z.uuid();

export type TaskOperationIdentity = z.infer<typeof operationIdentitySchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type SessionOperationInput = z.infer<typeof sessionOperationInputSchema>;

export type ClaudeSessionListPage = {
  nextOffset: number | null;
  sessions: SDKSessionInfo[];
};

export type ClaudeSessionHistoryPage = {
  messages: SessionMessage[];
  page: {
    beforeUuid: string | null;
    hasMoreBefore: boolean;
  };
};

export type TaskComposerOptions = {
  effortLevel: EffortLevel | null;
  models: ModelInfo[];
  supportedPermissionModes: PermissionMode[];
};

export type AuthorizedDirectory = {
  nonTerminalRuntimeCount: number;
  path: string;
  status: "available" | "unavailable";
  volumeRoot: boolean;
};

export type AuthorizedDirectorySnapshot = {
  directories: AuthorizedDirectory[];
  revision: number;
};

export type AddAuthorizedDirectoryResult = {
  coveringPath?: string;
  removedRedundantPaths: string[];
  result: "added" | "already-covered";
  selectedPath: string;
  snapshot: AuthorizedDirectorySnapshot;
};

export type RemoveAuthorizedDirectoryResult = {
  removedPath: string;
  snapshot: AuthorizedDirectorySnapshot;
  stoppedTaskCount: number;
};

export type TaskPathResolver = {
  canonicalize(path: string): Promise<string>;
};

export type TaskSdkSession = Pick<
  ClaudeSdkSession,
  | "close"
  | "events"
  | "initialize"
  | "interrupt"
  | "sessionId"
  | "setEffortLevel"
  | "setModel"
  | "setPermissionMode"
  | "submit"
>;

export type TaskSdkSessionFactory = (
  options: OpenClaudeSdkSessionOptions,
) => TaskSdkSession;

export type TaskManagerOptions = {
  claudeSessionCatalog?: ClaudeSessionCatalog;
  closeTaskAgentConnections?: { closeTaskConnections(taskId: string): void };
  createSession?: TaskSdkSessionFactory;
  directoryResolver?: WorkspaceDirectoryResolver;
  eventSink?: TaskEventSink;
  logger?: PocketPilotLogger;
  now?: () => number;
  authorizationCoordinator?: WorkspaceAuthorizationCoordinator;
  pathResolver?: TaskPathResolver;
  settingsRepository: SettingsRepository;
  sqlite: StorageDatabase;
  supportedPermissionModes?: readonly PermissionMode[];
};

type LiveTask = {
  composerInitialized: boolean;
  closed: boolean;
  effortLevel: EffortLevel | null;
  eventLoop: Promise<void> | undefined;
  interrupting: boolean;
  pendingQueryCount: number;
  pendingApproval:
    | { approval: PendingToolApproval; requestId: string }
    | undefined;
  session: TaskSdkSession | undefined;
  supportedModels: ModelInfo[];
};

type OperationExecution = {
  action: Exclude<TaskOperationAction, "archived" | "unarchived" | "deleted">;
  auditResult: string;
  task: TaskSnapshot;
};

type ResolvedConfiguredRoot = {
  path: string;
  status: "available" | "unavailable";
  storedPaths: string[];
};

type ResolvedRootProjection = {
  available: ResolvedConfiguredRoot[];
  unavailable: ResolvedConfiguredRoot[];
};

/**
 * Serializes per-task controls, owns only live SDK resources, and persists
 * task/session metadata. It deliberately never stores SDK input or output:
 * the SDK remains the canonical conversation owner.
 */
export class TaskManager {
  readonly #attachmentLane = new SerialExecutor();
  readonly #capacityLane = new SerialExecutor();
  readonly #claudeSessionCatalog: ClaudeSessionCatalog;
  readonly #closeTaskAgentConnections: {
    closeTaskConnections(taskId: string): void;
  };
  readonly #createSession: TaskSdkSessionFactory;
  readonly #directoryResolver: WorkspaceDirectoryResolver;
  readonly #eventSink: TaskEventSink | undefined;
  readonly #inFlightOperations = new Map<
    string,
    Promise<TaskOperationResult>
  >();
  readonly #liveTasks = new Map<string, LiveTask>();
  readonly #historyLanes = new Map<string, SerialExecutor>();
  readonly #logger: PocketPilotLogger;
  readonly #now: () => number;
  readonly #authorizationCoordinator: WorkspaceAuthorizationCoordinator;
  readonly #repository: TaskRepository;
  readonly #settingsRepository: SettingsRepository;
  readonly #supportedPermissionModes: readonly PermissionMode[];
  readonly #taskLanes = new Map<string, TaskOperationScheduler>();
  readonly #publishedTaskStates = new Map<string, TaskSnapshot["state"]>();
  readonly #providerInterruptTasks = new Set<string>();
  readonly #providerTurnReservations = new Set<string>();
  #authorizationRevision = 0;
  #providerTaskController: AgentTaskController | undefined;
  #shuttingDown = false;

  public constructor(options: TaskManagerOptions) {
    this.#claudeSessionCatalog =
      options.claudeSessionCatalog ?? installedClaudeSessionCatalog;
    this.#closeTaskAgentConnections = options.closeTaskAgentConnections ?? {
      closeTaskConnections: () => undefined,
    };
    this.#createSession = options.createSession ?? openClaudeSdkSession;
    this.#directoryResolver =
      options.directoryResolver ?? nodeWorkspaceDirectoryResolver;
    this.#eventSink = options.eventSink;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? Date.now;
    this.#authorizationCoordinator =
      options.authorizationCoordinator ??
      new WorkspaceAuthorizationCoordinator({
        ...(options.pathResolver === undefined
          ? {}
          : {
              fileSystem: {
                realpath: options.pathResolver.canonicalize,
                stat: async () => ({ isDirectory: () => true }),
              },
            }),
        settingsRepository: options.settingsRepository,
        strictSavedIdentity: false,
      });
    this.#repository = new TaskRepository(options.sqlite);
    for (const task of this.#repository.list()) {
      this.#publishedTaskStates.set(task.id, task.state);
    }
    this.#settingsRepository = options.settingsRepository;
    this.#supportedPermissionModes =
      options.supportedPermissionModes ?? pinnedPermissionModes;
  }

  public setProviderTaskController(controller: AgentTaskController): void {
    this.#providerTaskController = controller;
  }

  public providerTaskRuntime(): ProviderTaskRuntime {
    return {
      approvalRequested: (taskId, request) =>
        this.providerApprovalRequested(taskId, request),
      approvalResolved: (taskId, pendingRequestCount) =>
        this.providerApprovalResolved(taskId, pendingRequestCount),
      assertReadable: (taskId) => this.assertProviderTaskReadable(taskId),
      beginInterrupt: (taskId) => this.beginProviderInterrupt(taskId),
      completeInterrupt: (taskId) => this.completeProviderInterrupt(taskId),
      markTerminal: (taskId) => this.markProviderTaskTerminal(taskId),
      reserveTurn: (taskId, lease) => this.reserveProviderTurn(taskId, lease),
      rollbackTurn: (taskId) => this.rollbackProviderTurn(taskId),
      run: (taskId, operation) => this.runProviderTaskLane(taskId, operation),
      turnCompleted: (taskId) => this.completeProviderTurn(taskId),
      turnStarted: (taskId, nativeTurnId) =>
        this.startProviderTurn(taskId, nativeTurnId),
    };
  }

  /** Converts unfinished active work from a prior unexpected exit to interrupted. */
  public recoverFromUnexpectedRestart(): number {
    const recoveredTaskCount = this.#repository.markActiveTasksInterrupted(
      this.#now(),
    );
    if (recoveredTaskCount > 0) {
      this.#logger.info(
        logEvents.taskStateChanged,
        "Interrupted tasks recovered after restart",
        { recoveredTaskCount },
      );
    }
    return recoveredTaskCount;
  }

  public listTasks(): TaskSnapshot[] {
    return this.#repository.list();
  }

  public supportedPermissionModes(): readonly PermissionMode[] {
    return this.#supportedPermissionModes;
  }

  public authorizedWorkspaceRoots(): Promise<readonly string[]> {
    return this.#authorizationCoordinator.authorizedWorkspaceRoots();
  }

  /**
   * Canonicalizes and verifies a workspace before provider-native work runs.
   * Provider-neutral orchestration uses this boundary so every adapter gets
   * the same directory policy, while Claude retains checks for direct callers.
   */
  public async authorizeWorkspace(workspace: string): Promise<string> {
    return this.authorizeInitialWorkspace(workspace);
  }

  public async authorizedDirectorySnapshot(): Promise<AuthorizedDirectorySnapshot> {
    for (;;) {
      const revision = this.#authorizationRevision;
      const settings = readTaskRuntimeSettings(this.#settingsRepository);
      const projection = await this.resolveRootProjection(
        settings.workspaceRoots,
      );
      if (
        revision === this.#authorizationRevision &&
        sameStringArray(
          settings.workspaceRoots,
          readTaskRuntimeSettings(this.#settingsRepository).workspaceRoots,
        )
      ) {
        return this.buildAuthorizedDirectorySnapshot(projection, revision);
      }
    }
  }

  public async addAuthorizedDirectory(input: {
    selectedPath: string;
    volumeRootRiskAccepted: boolean;
  }): Promise<AddAuthorizedDirectoryResult> {
    let selectedPath: string;
    try {
      selectedPath = await this.#directoryResolver.canonicalizeDirectory(
        input.selectedPath,
      );
    } catch {
      throw authorizedDirectoryInvalidError();
    }
    if (!canonicalPathsEqual(selectedPath, input.selectedPath)) {
      throw authorizedDirectoryInvalidError();
    }
    if (isVolumeRoot(selectedPath) && !input.volumeRootRiskAccepted) {
      throw new TaskError(
        "VOLUME_ROOT_RISK_NOT_ACCEPTED",
        422,
        "Authorizing an entire volume requires explicit high-risk confirmation.",
      );
    }

    for (;;) {
      this.assertAcceptingWork();
      const revision = this.#authorizationRevision;
      const settings = readTaskRuntimeSettings(this.#settingsRepository);
      const projection = await this.resolveRootProjection(
        settings.workspaceRoots,
      );
      const currentSettings = readTaskRuntimeSettings(this.#settingsRepository);
      if (
        revision !== this.#authorizationRevision ||
        !sameStringArray(
          settings.workspaceRoots,
          currentSettings.workspaceRoots,
        )
      ) {
        continue;
      }

      const currentAvailableRoots = projection.available.map(
        (root) => root.path,
      );
      const addResult = addCanonicalRoot(currentAvailableRoots, selectedPath);
      const normalizedRoots = [
        ...addResult.roots,
        ...projection.unavailable.flatMap((root) => root.storedPaths),
      ];
      const changed = !sameStringArray(
        settings.workspaceRoots,
        normalizedRoots,
      );
      if (changed) {
        const now = this.#now();
        this.#repository.replaceWorkspaceRootsAndTerminalize({
          auditResult: `added:replaced-${
            addResult.kind === "added"
              ? addResult.removedRedundantRoots.length
              : 0
          }`,
          settings: { ...currentSettings, workspaceRoots: normalizedRoots },
          taskIds: [],
          updatedAt: now,
        });
        this.#authorizationRevision += 1;
      }

      const snapshot = await this.authorizedDirectorySnapshot();
      return addResult.kind === "already-covered"
        ? {
            coveringPath: addResult.coveringRoot,
            removedRedundantPaths: [],
            result: "already-covered",
            selectedPath,
            snapshot,
          }
        : {
            removedRedundantPaths: addResult.removedRedundantRoots,
            result: "added",
            selectedPath,
            snapshot,
          };
    }
  }

  public async removeAuthorizedDirectory(input: {
    expectedNonTerminalRuntimeCount: number;
    path: string;
    revision: number;
    runtimeStopAccepted: boolean;
  }): Promise<RemoveAuthorizedDirectoryResult> {
    if (!input.runtimeStopAccepted) {
      throw authorizedDirectoryInvalidError();
    }
    if (input.revision !== this.#authorizationRevision) {
      throw authorizedDirectorySnapshotStaleError();
    }

    const settings = readTaskRuntimeSettings(this.#settingsRepository);
    const projection = await this.resolveRootProjection(
      settings.workspaceRoots,
    );
    const currentSettings = readTaskRuntimeSettings(this.#settingsRepository);
    if (
      input.revision !== this.#authorizationRevision ||
      !sameStringArray(settings.workspaceRoots, currentSettings.workspaceRoots)
    ) {
      throw authorizedDirectorySnapshotStaleError();
    }

    const selectedAvailable = projection.available.find((root) =>
      canonicalPathsEqual(root.path, input.path),
    );
    const selectedUnavailable = projection.unavailable.find((root) =>
      canonicalPathsEqual(root.path, input.path),
    );
    const selected = selectedAvailable ?? selectedUnavailable;
    if (selected === undefined) {
      throw new TaskError(
        "AUTHORIZED_DIRECTORY_NOT_FOUND",
        404,
        "The authorized directory was not found.",
      );
    }

    const remainingAvailable = projection.available.filter(
      (root) => root !== selected,
    );
    const remainingUnavailable = projection.unavailable.filter(
      (root) => root !== selected,
    );
    const affectedTasks =
      selected.status === "available"
        ? this.nonTerminalTasksLosingAuthorization(
            selected.path,
            remainingAvailable.map((root) => root.path),
          )
        : [];
    if (
      affectedTasks.length !== input.expectedNonTerminalRuntimeCount ||
      input.revision !== this.#authorizationRevision
    ) {
      throw authorizedDirectorySnapshotStaleError();
    }

    const nextWorkspaceRoots = [
      ...remainingAvailable.map((root) => root.path),
      ...remainingUnavailable.flatMap((root) => root.storedPaths),
    ];
    const now = this.#now();
    const terminalTasks = this.#repository.replaceWorkspaceRootsAndTerminalize({
      auditResult: `removed:stopped-${affectedTasks.length}`,
      settings: { ...currentSettings, workspaceRoots: nextWorkspaceRoots },
      taskIds: affectedTasks.map((task) => task.id),
      updatedAt: now,
    });
    this.#authorizationRevision += 1;

    const interruptions: Promise<unknown>[] = [];
    for (const terminalTask of terminalTasks) {
      const liveTask = this.#liveTasks.get(terminalTask.id);
      this.#providerInterruptTasks.delete(terminalTask.id);
      this.#providerTurnReservations.delete(terminalTask.id);
      if (liveTask !== undefined) {
        liveTask.closed = true;
        liveTask.interrupting = false;
        this.#taskLanes.get(terminalTask.id)?.invalidate();
        this.cancelPendingApproval(
          liveTask,
          "Authorization for this task's workspace was removed.",
        );
        liveTask.pendingQueryCount = 0;
        const cleanup =
          terminalTask.provider === "claude"
            ? this.interruptSession(liveTask.session)
            : this.#providerTaskController?.close(terminalTask.id);
        if (cleanup !== undefined) {
          interruptions.push(cleanup);
        }
        this.closeSession(liveTask.session);
      } else if (terminalTask.provider !== "claude") {
        const cleanup = this.#providerTaskController?.close(terminalTask.id);
        if (cleanup !== undefined) {
          interruptions.push(cleanup);
        }
      }
      this.publishTaskState(terminalTask);
      this.#eventSink?.endTurn(terminalTask.id);
      this.#closeTaskAgentConnections.closeTaskConnections(terminalTask.id);
    }
    await Promise.allSettled(interruptions);

    return {
      removedPath: selected.path,
      snapshot: await this.authorizedDirectorySnapshot(),
      stoppedTaskCount: terminalTasks.length,
    };
  }

  public getTask(taskId: string): TaskSnapshot {
    this.assertTaskId(taskId);
    return this.requireTask(taskId);
  }

  public async listClaudeSessions(input: {
    limit?: number;
    offset?: number;
    workspace: string;
  }): Promise<ClaudeSessionListPage> {
    const parsed = listClaudeSessionsInputSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidTaskOperationError();
    }
    const workspace = await this.authorizeInitialWorkspace(
      parsed.data.workspace,
    );

    let sdkSessions: SDKSessionInfo[];
    try {
      sdkSessions = await this.#claudeSessionCatalog.list({
        dir: workspace,
        includeProgrammatic: true,
        includeWorktrees: false,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
    } catch (error) {
      if (error instanceof TaskError) {
        throw error;
      }
      throw taskSessionUnavailableError(
        "Claude sessions are currently unavailable.",
      );
    }

    const sessions: SDKSessionInfo[] = [];
    for (const sdkSession of sdkSessions) {
      if (
        sdkSession.cwd === undefined ||
        (await this.isSessionCwdAuthorized(workspace, sdkSession.cwd))
      ) {
        sessions.push(sdkSession);
      }
    }

    return this.withCurrentWorkspaceAuthorization(workspace, () => ({
      nextOffset:
        sdkSessions.length < parsed.data.limit
          ? null
          : parsed.data.offset + sdkSessions.length,
      sessions,
    }));
  }

  public async readClaudeSessionHistory(input: {
    beforeUuid?: string;
    includeSystemMessages?: boolean;
    limit?: number;
    sessionId: string;
    workspace: string;
  }): Promise<ClaudeSessionHistoryPage> {
    const parsed = readClaudeSessionHistoryInputSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidTaskOperationError();
    }
    const workspace = await this.authorizeInitialWorkspace(
      parsed.data.workspace,
    );
    const laneKey = `${workspace}\0${parsed.data.sessionId}`;
    return this.runHistoryLane(laneKey, async () => {
      await this.requireAuthorizedClaudeSession(
        workspace,
        parsed.data.sessionId,
      );

      let messages: SessionMessage[];
      try {
        messages = await this.#claudeSessionCatalog.getMessages(
          parsed.data.sessionId,
          {
            dir: workspace,
            includeSystemMessages: parsed.data.includeSystemMessages,
          },
        );
      } catch {
        throw new TaskError(
          "CLAUDE_HISTORY_UNAVAILABLE",
          409,
          "Claude session history is temporarily unavailable.",
        );
      }

      return this.withCurrentWorkspaceAuthorization(workspace, () => {
        const end =
          parsed.data.beforeUuid === undefined
            ? messages.length
            : messages.findIndex(
                (message) => message.uuid === parsed.data.beforeUuid,
              );
        if (end < 0) {
          throw new TaskError(
            "HISTORY_CURSOR_STALE",
            409,
            "The history cursor is stale; reload the latest history page.",
          );
        }
        const start = Math.max(0, end - parsed.data.limit);
        const pageMessages = messages.slice(start, end);
        const hasMoreBefore = start > 0;
        return {
          messages: pageMessages,
          page: {
            beforeUuid:
              hasMoreBefore && pageMessages[0] !== undefined
                ? pageMessages[0].uuid
                : null,
            hasMoreBefore,
          },
        };
      });
    });
  }

  public async createClaudeConversation(
    input: SessionOperationInput,
  ): Promise<TaskBoundOperationResult> {
    const parsed = sessionOperationInputSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidTaskOperationError();
    }
    this.assertWorkspaceRiskAccepted(parsed.data.workspaceRiskAccepted);

    return this.executeIdempotent(parsed.data, async () =>
      this.#attachmentLane.run(async () => {
        this.assertAcceptingWork();
        const initialCwd = await this.authorizeInitialWorkspace(
          parsed.data.workspace,
        );
        return this.withCurrentWorkspaceAuthorization(initialCwd, () => {
          const now = this.#now();
          const task = this.#repository.create({
            createdAt: now,
            id: randomUUID(),
            initialCwd,
            model: null,
            nativeProtocolVersion: claudeAgentSdkProtocolVersion,
            origin: "claude-session",
            permissionMode: null,
            provider: "claude",
            sdkSessionId: null,
          });
          this.#logger.info(logEvents.taskCreated, "Task created", {
            origin: task.origin,
            state: task.state,
            taskId: task.id,
          });
          this.#publishedTaskStates.set(task.id, task.state);
          return {
            action: "created" as const,
            auditResult: "workspace-risk-accepted",
            task,
          };
        });
      }),
    ) as Promise<TaskBoundOperationResult>;
  }

  public async attachClaudeSession(
    input: SessionOperationInput & { sessionId: string },
  ): Promise<TaskBoundOperationResult> {
    const parsed = attachClaudeSessionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidTaskOperationError();
    }
    this.assertWorkspaceRiskAccepted(parsed.data.workspaceRiskAccepted);

    return this.executeIdempotent(parsed.data, async () =>
      this.#attachmentLane.run(async () => {
        this.assertAcceptingWork();
        const initialCwd = await this.authorizeInitialWorkspace(
          parsed.data.workspace,
        );
        await this.requireAuthorizedClaudeSession(
          initialCwd,
          parsed.data.sessionId,
        );

        return this.withCurrentWorkspaceAuthorization(initialCwd, () => {
          const existing = this.#repository.findNonTerminalBySdkSessionId(
            parsed.data.sessionId,
          );
          const task =
            existing === undefined
              ? this.createAttachedTask(initialCwd, parsed.data.sessionId)
              : this.adoptAttachedTask(existing);
          this.#logger.info(logEvents.taskAttached, "Claude session attached", {
            reused: existing !== undefined,
            state: task.state,
            taskId: task.id,
          });
          this.#publishedTaskStates.set(task.id, task.state);
          return {
            action: "attached" as const,
            auditResult: "workspace-risk-accepted",
            task,
          };
        });
      }),
    ) as Promise<TaskBoundOperationResult>;
  }

  /** Activates only session-centric runtimes after the raw subscriber exists. */
  public async activateSdkSession(taskId: string): Promise<void> {
    this.assertTaskId(taskId);
    this.#logger.info(
      logEvents.taskActivationStarted,
      "Task activation started",
      { taskId },
    );
    await this.runTaskLane(taskId, async (lease) => {
      this.assertAcceptingWork();
      let task = this.requireTask(taskId);
      this.assertTaskNotTerminal(task);
      if (task.origin !== "claude-session") {
        return;
      }
      await this.assertTaskWorkspaceAuthorized(task);
      task = this.requireTask(taskId);
      this.assertTaskNotTerminal(task);
      if (task.state === "interrupted") {
        task = this.#repository.update(task.id, {
          interruptedAt: null,
          state: "idle",
          updatedAt: this.#now(),
        });
      }
      const liveTask = this.liveTask(task.id);
      const session = this.ensureSession(task);
      await this.initializeComposer(task, liveTask, session, lease);
    });
    this.#logger.info(logEvents.taskActivated, "Task activation completed", {
      taskId,
    });
  }

  public async getComposerOptions(
    taskId: string,
  ): Promise<TaskComposerOptions> {
    this.assertTaskId(taskId);
    return this.runTaskLane(taskId, async (lease) => {
      const task = this.requireTask(taskId);
      this.assertTaskNotTerminal(task);
      this.assertClaudeTaskControl(task);
      if (task.state === "interrupted") {
        throw interruptedTaskError();
      }
      const liveTask = this.liveTask(task.id);
      const session = liveTask.session;
      if (session === undefined) {
        throw taskSessionUnavailableError(
          "Connect the raw SDK stream before requesting composer options.",
        );
      }
      await this.initializeComposer(task, liveTask, session, lease);
      lease.assertCurrent();
      return {
        effortLevel: liveTask.effortLevel,
        models: [...liveTask.supportedModels],
        supportedPermissionModes: [...this.#supportedPermissionModes],
      };
    });
  }

  public async createTask(
    input: CreateTaskInput,
  ): Promise<TaskOperationResult> {
    const parsed = createTaskInputSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidTaskOperationError();
    }
    this.assertWorkspaceRiskAccepted(parsed.data.workspaceRiskAccepted);
    if (!this.isSupportedPermissionMode(parsed.data.permissionMode)) {
      throw new TaskError(
        "UNSUPPORTED_PERMISSION_MODE",
        422,
        "The requested Claude permission mode is not supported by this Agent.",
      );
    }

    return this.executeIdempotent(parsed.data, async () =>
      this.#capacityLane.run(async () => {
        this.assertAcceptingWork();
        const settings =
          this.#authorizationCoordinator.readTaskRuntimeSettings();
        if (
          this.#repository.countActiveTasks() >= settings.concurrentTaskCapacity
        ) {
          throw new TaskError(
            "CONCURRENT_TASK_LIMIT_REACHED",
            409,
            "The configured concurrent-task capacity has been reached.",
          );
        }

        const initialCwd = await this.authorizeInitialWorkspace(
          parsed.data.initialCwd,
        );
        return this.withCurrentWorkspaceAuthorization(initialCwd, () => {
          const now = this.#now();
          const task = this.#repository.create({
            createdAt: now,
            id: randomUUID(),
            initialCwd,
            model: parsed.data.model ?? null,
            nativeProtocolVersion: claudeAgentSdkProtocolVersion,
            origin: "pocketpilot",
            permissionMode: parsed.data.permissionMode,
            provider: "claude",
          });
          this.#logger.info(logEvents.taskCreated, "Task created", {
            origin: task.origin,
            state: task.state,
            taskId: task.id,
          });
          this.#publishedTaskStates.set(task.id, task.state);
          return {
            action: "created" as const,
            auditResult: "workspace-risk-accepted",
            task,
          };
        });
      }),
    );
  }

  public async submitSdkMessage(input: {
    deviceId: string;
    message: SDKUserMessage;
    taskId: string;
  }): Promise<TaskSnapshot> {
    if (!deviceIdSchema.safeParse(input.deviceId).success) {
      throw invalidTaskOperationError();
    }
    this.assertTaskId(input.taskId);
    this.#logger.debug(
      logEvents.sdkMessageObserved,
      "SDK user message accepted",
      {
        hasUuid: input.message.uuid !== undefined,
        priority: input.message.priority ?? "default",
        shouldQuery: input.message.shouldQuery !== false,
        sdkType: input.message.type,
        taskId: input.taskId,
      },
    );

    return this.runTaskLane(input.taskId, async (lease) => {
      this.assertAcceptingWork();
      let task = this.requireTask(input.taskId);
      this.assertTaskCanAcceptSdkMessage(task);
      await this.assertTaskWorkspaceAuthorized(task);
      task = this.requireTask(input.taskId);
      this.assertTaskCanAcceptSdkMessage(task);
      const startsQuery = input.message.shouldQuery !== false;

      if (task.state === "idle" && startsQuery) {
        return this.#capacityLane.run(() => {
          lease.assertCurrent();
          return this.startSdkTurn(
            input.deviceId,
            task.id,
            input.message,
            lease,
          );
        });
      }

      lease.assertCurrent();
      this.submitToSession(task, input.message);
      if (startsQuery) {
        this.liveTask(task.id).pendingQueryCount += 1;
      }
      this.recordSdkInputAudit(input.deviceId, task.id, startsQuery);
      return task;
    });
  }

  /** User interruption bypasses ordinary control lanes and completes before reuse. */
  public async interruptTask(
    input: {
      taskId: string;
    } & TaskOperationIdentity,
  ): Promise<TaskOperationResult> {
    const identity = this.parseOperationIdentity(input);
    this.assertTaskId(input.taskId);

    return this.executeIdempotent(identity, async () => {
      const task = this.requireTask(input.taskId);
      this.assertTaskNotTerminal(task);
      if (task.state === "interrupted") {
        throw interruptedTaskError();
      }
      const liveTask = this.liveTask(task.id);
      liveTask.interrupting = true;
      this.#taskLanes.get(task.id)?.invalidate();
      this.#providerTurnReservations.delete(task.id);
      this.cancelPendingApproval(liveTask, "The user interrupted this task.");
      liveTask.pendingQueryCount = 0;
      const wasIdle = task.state === "idle";
      const interrupted = this.#repository.update(task.id, {
        interruptedAt: this.#now(),
        state: "interrupted",
        updatedAt: this.#now(),
      });
      this.publishTaskState(interrupted);
      this.#eventSink?.endTurn(task.id);

      const interrupt =
        task.provider === "claude"
          ? this.interruptSession(liveTask.session)
          : this.#providerTaskController?.interrupt(task.id);
      await Promise.allSettled(interrupt === undefined ? [] : [interrupt]);
      liveTask.interrupting = false;

      const current = this.requireTask(task.id);
      const updated =
        current.state === "terminal"
          ? current
          : this.#repository.update(task.id, {
              activeTurnId: null,
              interruptedAt: null,
              state: "idle",
              updatedAt: this.#now(),
            });
      this.publishTaskState(updated);
      this.#logger.info(logEvents.taskControlCompleted, "Task interrupted", {
        operation: "interrupt",
        result: wasIdle ? "already-idle" : "interrupted",
        taskId: task.id,
      });
      return {
        action: "interrupted",
        auditResult: wasIdle ? "already-idle" : "interrupted",
        task: updated,
      };
    });
  }

  /** User close has the highest priority and never waits behind a task lane. */
  public async closeTask(
    input: {
      taskId: string;
    } & TaskOperationIdentity,
  ): Promise<TaskOperationResult> {
    const identity = this.parseOperationIdentity(input);
    this.assertTaskId(input.taskId);

    return this.executeIdempotent(identity, async () => {
      const task = this.requireTask(input.taskId);
      this.assertTaskNotTerminal(task);
      const liveTask = this.liveTask(task.id);
      liveTask.closed = true;
      liveTask.interrupting = false;
      this.#taskLanes.get(task.id)?.invalidate();
      this.#providerInterruptTasks.delete(task.id);
      this.#providerTurnReservations.delete(task.id);
      this.cancelPendingApproval(liveTask, "The user closed this task.");
      liveTask.pendingQueryCount = 0;
      const terminal = this.#repository.update(task.id, {
        activeTurnId: null,
        state: "terminal",
        terminalAt: this.#now(),
        updatedAt: this.#now(),
      });
      this.publishTaskState(terminal);
      this.#eventSink?.endTurn(task.id);
      this.#closeTaskAgentConnections.closeTaskConnections(task.id);
      const interrupt =
        task.provider === "claude"
          ? this.interruptSession(liveTask.session)
          : this.#providerTaskController?.close(task.id);
      this.closeSession(liveTask.session);
      await Promise.allSettled(interrupt === undefined ? [] : [interrupt]);
      this.#logger.info(logEvents.taskControlCompleted, "Task closed", {
        operation: "close",
        result: "closed",
        taskId: task.id,
      });
      return { action: "closed", auditResult: "closed", task: terminal };
    });
  }

  public async resumeTask(
    input: {
      taskId: string;
    } & TaskOperationIdentity,
  ): Promise<TaskOperationResult> {
    const identity = this.parseOperationIdentity(input);
    this.assertTaskId(input.taskId);

    return this.executeIdempotent(identity, async () =>
      this.runTaskLane(input.taskId, async (lease) => {
        this.assertAcceptingWork();
        let task = this.requireTask(input.taskId);
        this.assertTaskNotTerminal(task);
        if (task.state !== "interrupted") {
          throw new TaskError(
            "TASK_BUSY",
            409,
            "Only an interrupted task can be resumed.",
          );
        }
        if (task.provider !== "claude") {
          await this.#providerTaskController?.resume(task.id);
          lease.assertCurrent();
          const resumed = this.#repository.update(task.id, {
            interruptedAt: null,
            state: "idle",
            updatedAt: this.#now(),
          });
          return {
            action: "resumed" as const,
            auditResult: "resumed",
            task: resumed,
          };
        }
        if (task.sdkSessionId === null) {
          throw new TaskError(
            "TASK_SESSION_UNAVAILABLE",
            409,
            "The interrupted task has no saved Claude session reference.",
          );
        }

        await this.assertTaskWorkspaceAuthorized(task);
        task = this.requireTask(input.taskId);
        this.assertTaskNotTerminal(task);
        if (task.state !== "interrupted") {
          throw new TaskError(
            "TASK_BUSY",
            409,
            "Only an interrupted task can be resumed.",
          );
        }
        lease.assertCurrent();
        this.ensureSession(task);
        lease.assertCurrent();
        const resumed = this.#repository.update(task.id, {
          state: "idle",
          updatedAt: this.#now(),
        });
        this.#logger.info(logEvents.taskControlCompleted, "Task resumed", {
          operation: "resume",
          result: "resumed",
          taskId: task.id,
        });
        return { action: "resumed", auditResult: "resumed", task: resumed };
      }),
    );
  }

  public async resolveApproval(
    input: {
      requestId: string;
      result: PermissionResult;
      taskId: string;
    } & TaskOperationIdentity,
  ): Promise<TaskOperationResult> {
    const identity = this.parseOperationIdentity(input);
    this.assertTaskId(input.taskId);
    if (input.requestId.trim().length === 0) {
      throw invalidTaskOperationError();
    }

    return this.executeIdempotent(identity, async () =>
      this.runTaskLane(input.taskId, (lease) => {
        const task = this.requireTask(input.taskId);
        this.assertTaskNotTerminal(task);
        this.assertClaudeTaskControl(task);
        const liveTask = this.liveTask(task.id);
        const pending = liveTask.pendingApproval;
        if (
          task.state !== "awaiting_approval" ||
          pending === undefined ||
          pending.requestId !== input.requestId
        ) {
          throw new TaskError(
            "STALE_APPROVAL",
            409,
            "The requested tool approval is no longer pending.",
          );
        }

        lease.assertCurrent();
        pending.approval.resolve(input.result);
        liveTask.pendingApproval = undefined;
        lease.assertCurrent();
        const executing = this.#repository.update(task.id, {
          state: "executing",
          updatedAt: this.#now(),
        });
        this.publishTaskState(executing);
        this.#logger.info(
          logEvents.taskApprovalResolved,
          "Task approval resolved",
          {
            requestId: input.requestId,
            result: input.result.behavior,
            taskId: task.id,
          },
        );
        return {
          action:
            input.result.behavior === "allow"
              ? "approval-approved"
              : "approval-denied",
          auditResult: input.result.behavior,
          task: executing,
        };
      }),
    );
  }

  public async setModel(
    input: {
      model: string | undefined;
      taskId: string;
    } & TaskOperationIdentity,
  ): Promise<TaskOperationResult> {
    const identity = this.parseOperationIdentity(input);
    this.assertTaskId(input.taskId);
    if (input.model !== undefined && input.model.trim().length === 0) {
      throw invalidTaskOperationError();
    }

    return this.executeIdempotent(identity, async () =>
      this.runTaskLane(input.taskId, async (lease) => {
        const task = this.requireTask(input.taskId);
        this.assertTaskNotTerminal(task);
        this.assertClaudeTaskControl(task);
        if (task.state === "interrupted") {
          throw interruptedTaskError();
        }
        const liveTask = this.liveTask(task.id);
        if (liveTask.session !== undefined) {
          lease.assertCurrent();
          await liveTask.session.setModel(input.model);
          lease.assertCurrent();
        } else if (task.origin === "claude-session") {
          throw taskSessionUnavailableError(
            "Connect the raw SDK stream before changing the model.",
          );
        }
        lease.assertCurrent();
        const current = this.requireTask(task.id);
        const updated =
          task.origin === "claude-session"
            ? current
            : this.#repository.update(task.id, {
                model: input.model ?? null,
                updatedAt: this.#now(),
              });
        this.#logger.info(
          logEvents.taskControlCompleted,
          "Task model control completed",
          { operation: "set-model", result: "changed", taskId: task.id },
        );
        return {
          action: "model-changed",
          auditResult: "changed",
          task: updated,
        };
      }),
    );
  }

  public async setPermissionMode(
    input: {
      permissionMode: string;
      taskId: string;
    } & TaskOperationIdentity,
  ): Promise<TaskOperationResult> {
    const identity = this.parseOperationIdentity(input);
    this.assertTaskId(input.taskId);
    const permissionMode = input.permissionMode;
    if (!this.isSupportedPermissionMode(permissionMode)) {
      throw new TaskError(
        "UNSUPPORTED_PERMISSION_MODE",
        422,
        "The requested Claude permission mode is not supported by this Agent.",
      );
    }

    return this.executeIdempotent(identity, async () =>
      this.runTaskLane(input.taskId, async (lease) => {
        const task = this.requireTask(input.taskId);
        this.assertTaskNotTerminal(task);
        this.assertClaudeTaskControl(task);
        if (task.state === "interrupted") {
          throw interruptedTaskError();
        }

        const liveTask = this.liveTask(task.id);
        if (liveTask.session !== undefined) {
          lease.assertCurrent();
          await liveTask.session.setPermissionMode(permissionMode);
          lease.assertCurrent();
        } else if (task.origin === "claude-session") {
          throw taskSessionUnavailableError(
            "Connect the raw SDK stream before changing the permission mode.",
          );
        }
        lease.assertCurrent();
        const current = this.requireTask(task.id);
        const updated =
          task.origin === "claude-session"
            ? current
            : this.#repository.update(task.id, {
                permissionMode,
                updatedAt: this.#now(),
              });
        this.#logger.info(
          logEvents.taskControlCompleted,
          "Task permission control completed",
          {
            operation: "set-permission-mode",
            result: "changed",
            taskId: task.id,
          },
        );
        return {
          action: "permission-mode-changed",
          auditResult: "changed",
          task: updated,
        };
      }),
    );
  }

  public async setEffortLevel(
    input: {
      effortLevel: EffortLevel | null;
      taskId: string;
    } & TaskOperationIdentity,
  ): Promise<TaskOperationResult> {
    const identity = this.parseOperationIdentity(input);
    this.assertTaskId(input.taskId);
    if (
      input.effortLevel !== null &&
      !this.isSupportedEffortLevel(input.effortLevel)
    ) {
      throw invalidTaskOperationError();
    }

    return this.executeIdempotent(identity, async () =>
      this.runTaskLane(input.taskId, async (lease) => {
        const task = this.requireTask(input.taskId);
        this.assertTaskNotTerminal(task);
        this.assertClaudeTaskControl(task);
        if (task.state === "interrupted") {
          throw interruptedTaskError();
        }
        const liveTask = this.liveTask(task.id);
        if (liveTask.session === undefined) {
          throw taskSessionUnavailableError(
            "Connect the raw SDK stream before changing the effort level.",
          );
        }
        lease.assertCurrent();
        await liveTask.session.setEffortLevel(input.effortLevel);
        lease.assertCurrent();
        const current = this.requireTask(task.id);
        liveTask.effortLevel = input.effortLevel;
        this.#logger.info(
          logEvents.taskControlCompleted,
          "Task effort control completed",
          { operation: "set-effort", result: "changed", taskId: task.id },
        );
        return {
          action: "effort-changed",
          auditResult: "changed",
          task: current,
        };
      }),
    );
  }

  /** Cancels live SDK work, then makes every remaining task non-resumable. */
  public async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }
    this.#shuttingDown = true;

    const now = this.#now();
    const nonTerminalTasks = this.#repository
      .list()
      .filter((task) => task.state !== "terminal");
    this.#repository.markNonTerminalTasksTerminal(now);
    const interruptions: Promise<unknown>[] = [];
    for (const task of nonTerminalTasks) {
      const liveTask = this.#liveTasks.get(task.id);
      this.#taskLanes.get(task.id)?.invalidate();
      this.#providerInterruptTasks.delete(task.id);
      this.#providerTurnReservations.delete(task.id);
      if (liveTask !== undefined) {
        liveTask.closed = true;
        liveTask.interrupting = false;
        this.cancelPendingApproval(liveTask, "The Agent is shutting down.");
        liveTask.pendingQueryCount = 0;
        if (task.provider === "claude" && liveTask.session !== undefined) {
          const interrupt = this.interruptSession(liveTask.session);
          if (interrupt !== undefined) {
            interruptions.push(interrupt);
          }
          this.closeSession(liveTask.session);
        } else if (task.provider !== "claude") {
          const cleanup = this.#providerTaskController?.close(task.id);
          if (cleanup !== undefined) {
            interruptions.push(cleanup);
          }
        }
      } else if (task.provider !== "claude") {
        const cleanup = this.#providerTaskController?.close(task.id);
        if (cleanup !== undefined) {
          interruptions.push(cleanup);
        }
      }
      const terminal = this.requireTask(task.id);
      this.publishTaskState(terminal);
      this.#eventSink?.endTurn(task.id);
      this.#closeTaskAgentConnections.closeTaskConnections(task.id);
    }
    await Promise.allSettled(interruptions);
    this.#liveTasks.clear();
    this.#logger.info(
      logEvents.taskShutdownCompleted,
      "Task shutdown completed",
      { taskCount: nonTerminalTasks.length },
    );
    this.#taskLanes.clear();
    this.#providerInterruptTasks.clear();
    this.#providerTurnReservations.clear();
  }

  private adoptAttachedTask(task: TaskSnapshot): TaskSnapshot {
    if (
      task.origin === "claude-session" &&
      task.model === null &&
      task.permissionMode === null &&
      task.state !== "interrupted"
    ) {
      return task;
    }
    return this.#repository.update(task.id, {
      ...(task.state === "interrupted"
        ? { interruptedAt: null, state: "idle" as const }
        : {}),
      model: null,
      origin: "claude-session",
      permissionMode: null,
      updatedAt: this.#now(),
    });
  }

  private assertWorkspaceRiskAccepted(accepted: boolean): void {
    if (!accepted) {
      throw new TaskError(
        "WORKSPACE_SCOPE_RISK_NOT_ACCEPTED",
        422,
        "The operation requires accepting the workspace scope risk.",
      );
    }
  }

  private createAttachedTask(
    initialCwd: string,
    sdkSessionId: string,
  ): TaskSnapshot {
    const now = this.#now();
    try {
      return this.#repository.create({
        createdAt: now,
        id: randomUUID(),
        initialCwd,
        model: null,
        nativeProtocolVersion: claudeAgentSdkProtocolVersion,
        origin: "claude-session",
        permissionMode: null,
        provider: "claude",
        sdkSessionId,
      });
    } catch {
      const winner =
        this.#repository.findNonTerminalBySdkSessionId(sdkSessionId);
      if (winner !== undefined) {
        return this.adoptAttachedTask(winner);
      }
      throw new TaskError(
        "CLAUDE_SESSION_CONFLICT",
        409,
        "The Claude session is already attached to another runtime.",
      );
    }
  }

  private async initializeComposer(
    task: TaskSnapshot,
    liveTask: LiveTask,
    session: TaskSdkSession,
    lease: TaskOperationLease,
  ): Promise<void> {
    if (liveTask.composerInitialized) {
      return;
    }

    let initialization: ClaudeSdkInitialization;
    try {
      initialization = await session.initialize();
      lease.assertCurrent();
    } catch (error) {
      if (error instanceof TaskError) {
        throw error;
      }
      throw taskSessionUnavailableError(
        "Claude session initialization is currently unavailable.",
      );
    }

    let effortLevel: EffortLevel | null = null;
    try {
      const settings = await this.#claudeSessionCatalog.resolveSettings({
        cwd: task.initialCwd,
      });
      lease.assertCurrent();
      const configuredEffort = settings.effective.effortLevel;
      if (
        configuredEffort !== undefined &&
        this.isSupportedEffortLevel(configuredEffort)
      ) {
        effortLevel = configuredEffort;
      }
    } catch (error) {
      if (error instanceof TaskError) {
        throw error;
      }
      // Query initialization remains authoritative and usable when optional
      // settings projection is unavailable.
    }

    liveTask.supportedModels = initialization.models;
    liveTask.effortLevel = effortLevel;
    liveTask.composerInitialized = true;
  }

  private isSessionCwdAuthorized(
    workspace: string,
    sessionCwd: string,
  ): Promise<boolean> {
    return this.#authorizationCoordinator.isPathWithinWorkspace(
      workspace,
      sessionCwd,
    );
  }

  private async requireAuthorizedClaudeSession(
    workspace: string,
    sessionId: string,
  ): Promise<SDKSessionInfo> {
    let session: SDKSessionInfo | undefined;
    try {
      session = await this.#claudeSessionCatalog.getInfo(sessionId, {
        dir: workspace,
      });
    } catch {
      throw taskSessionUnavailableError(
        "The selected Claude session is currently unavailable.",
      );
    }
    if (session === undefined) {
      throw claudeSessionNotFoundError();
    }
    if (session.cwd !== undefined) {
      if (!(await this.isSessionCwdAuthorized(workspace, session.cwd))) {
        throw claudeSessionNotFoundError();
      }
      return session;
    }

    let workspaceSessions: SDKSessionInfo[];
    try {
      workspaceSessions = await this.#claudeSessionCatalog.list({
        dir: workspace,
        includeProgrammatic: true,
        includeWorktrees: false,
      });
    } catch {
      throw taskSessionUnavailableError(
        "The selected Claude session is currently unavailable.",
      );
    }
    const workspaceSession = workspaceSessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (workspaceSession === undefined) {
      throw claudeSessionNotFoundError();
    }
    if (
      workspaceSession.cwd !== undefined &&
      !(await this.isSessionCwdAuthorized(workspace, workspaceSession.cwd))
    ) {
      throw claudeSessionNotFoundError();
    }
    return session;
  }

  private async authorizeInitialWorkspace(
    requestedCwd: string,
  ): Promise<string> {
    try {
      return await this.#authorizationCoordinator.authorizeWorkspace(
        requestedCwd,
      );
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError) {
        throw new TaskError(
          "WORKSPACE_NOT_AUTHORIZED",
          403,
          "The requested working directory is not an authorized workspace.",
        );
      }
      throw error;
    }
  }

  private async assertTaskWorkspaceAuthorized(
    task: TaskSnapshot,
  ): Promise<void> {
    await this.authorizeInitialWorkspace(task.initialCwd);
  }

  private async withCurrentWorkspaceAuthorization<T>(
    workspace: string,
    operation: () => T,
  ): Promise<T> {
    for (;;) {
      const revision = this.#authorizationRevision;
      await this.authorizeInitialWorkspace(workspace);
      if (revision === this.#authorizationRevision) {
        return operation();
      }
    }
  }

  private buildAuthorizedDirectorySnapshot(
    projection: ResolvedRootProjection,
    revision: number,
  ): AuthorizedDirectorySnapshot {
    const directories: AuthorizedDirectory[] = projection.available.map(
      (root) => ({
        nonTerminalRuntimeCount: this.nonTerminalTasksLosingAuthorization(
          root.path,
          projection.available
            .filter((candidate) => candidate !== root)
            .map((candidate) => candidate.path),
        ).length,
        path: root.path,
        status: "available",
        volumeRoot: isVolumeRoot(root.path),
      }),
    );
    directories.push(
      ...projection.unavailable.map((root) => ({
        nonTerminalRuntimeCount: 0,
        path: root.path,
        status: "unavailable" as const,
        volumeRoot: isVolumeRoot(root.path),
      })),
    );
    return { directories, revision };
  }

  private nonTerminalTasksLosingAuthorization(
    removedRoot: string,
    remainingRoots: readonly string[],
  ): TaskSnapshot[] {
    return this.#repository
      .list()
      .filter(
        (task) =>
          task.state !== "terminal" &&
          isPathWithinRoot(removedRoot, task.initialCwd) &&
          !remainingRoots.some((root) =>
            isPathWithinRoot(root, task.initialCwd),
          ),
      );
  }

  private async resolveRootProjection(
    storedRoots: readonly string[],
  ): Promise<ResolvedRootProjection> {
    const available: ResolvedConfiguredRoot[] = [];
    const unavailable: ResolvedConfiguredRoot[] = [];
    for (const storedPath of storedRoots) {
      let path: string;
      try {
        path = await this.#directoryResolver.canonicalizeDirectory(storedPath);
      } catch {
        const duplicate = unavailable.find((root) =>
          canonicalPathsEqual(root.path, storedPath),
        );
        if (duplicate === undefined) {
          unavailable.push({
            path: storedPath,
            status: "unavailable",
            storedPaths: [storedPath],
          });
        } else {
          duplicate.storedPaths.push(storedPath);
        }
        continue;
      }

      const coveringRoot = available.find((root) =>
        isPathWithinRoot(root.path, path),
      );
      if (coveringRoot !== undefined) {
        coveringRoot.storedPaths.push(storedPath);
        continue;
      }

      const coveredRoots = available.filter((root) =>
        isPathWithinRoot(path, root.path),
      );
      for (const coveredRoot of coveredRoots) {
        available.splice(available.indexOf(coveredRoot), 1);
      }
      available.push({
        path,
        status: "available",
        storedPaths: [
          storedPath,
          ...coveredRoots.flatMap((root) => root.storedPaths),
        ],
      });
    }
    return { available, unavailable };
  }

  private cancelPendingApproval(liveTask: LiveTask, message: string): void {
    liveTask.pendingApproval?.approval.cancel(message);
    liveTask.pendingApproval = undefined;
  }

  private completeActiveTurn(taskId: string, allQueriesIdle: boolean): void {
    const task = this.#repository.find(taskId);
    if (
      task === undefined ||
      (task.state !== "executing" && task.state !== "awaiting_approval")
    ) {
      return;
    }

    const liveTask = this.liveTask(taskId);
    if (liveTask.closed || liveTask.interrupting) {
      return;
    }
    if (!allQueriesIdle && liveTask.pendingQueryCount > 1) {
      liveTask.pendingQueryCount -= 1;
      this.#eventSink?.beginTurn(taskId);
      return;
    }
    liveTask.pendingQueryCount = 0;
    this.cancelPendingApproval(liveTask, "The Claude turn has already ended.");
    const idle = this.#repository.update(taskId, {
      state: "idle",
      updatedAt: this.#now(),
    });
    this.publishTaskState(idle);
    this.#eventSink?.endTurn(taskId);
  }

  private consumeSessionEvents(
    taskId: string,
    session: TaskSdkSession,
  ): Promise<void> {
    return (async () => {
      try {
        for await (const message of session.events()) {
          const liveTask = this.#liveTasks.get(taskId);
          if (
            liveTask === undefined ||
            liveTask.closed ||
            liveTask.session !== session
          ) {
            return;
          }
          if (liveTask.interrupting) {
            continue;
          }
          const sdkSubtype = readSdkSubtype(message);
          this.#logger.debug(
            logEvents.sdkMessageObserved,
            "SDK message observed",
            {
              hasUuid: readSdkUuidPresence(message),
              ...(sdkSubtype === undefined ? {} : { sdkSubtype }),
              sdkType: message.type,
              taskId,
            },
          );
          this.persistSessionId(taskId, session);
          this.#eventSink?.publishSdkMessage(taskId, message);
          if (message.type === "result") {
            this.#logger.info(logEvents.sdkQueryResult, "SDK Query completed", {
              ...(sdkSubtype === undefined ? {} : { result: sdkSubtype }),
              taskId,
            });
            this.completeActiveTurn(taskId, false);
          } else if (
            message.type === "system" &&
            message.subtype === "session_state_changed" &&
            message.state === "idle"
          ) {
            this.completeActiveTurn(taskId, true);
          }
        }
      } catch (error) {
        this.#logger.error(logEvents.sdkQueryFailed, "SDK Query failed", {
          ...safeErrorFields(error),
          taskId,
        });
        this.completeActiveTurn(taskId, true);
      } finally {
        const liveTask = this.#liveTasks.get(taskId);
        if (liveTask?.session === session) {
          liveTask.session = undefined;
          liveTask.eventLoop = undefined;
        }
        this.#logger.info(logEvents.sdkQueryStopped, "SDK Query stopped", {
          taskId,
        });
      }
    })();
  }

  private ensureSession(task: TaskSnapshot): TaskSdkSession {
    const liveTask = this.liveTask(task.id);
    if (liveTask.closed) {
      throw new TaskError(
        "TASK_TERMINAL",
        409,
        "The task is closed and cannot accept further control operations.",
      );
    }
    if (liveTask.session !== undefined) {
      return liveTask.session;
    }

    liveTask.composerInitialized = false;
    liveTask.effortLevel = null;
    liveTask.supportedModels = [];
    const session = this.#createSession({
      canUseTool: createToolApprovalHandler((approval) => {
        this.registerPendingApproval(task.id, approval);
      }),
      cwd: task.initialCwd,
      ...(task.origin === "pocketpilot" && task.model !== null
        ? { model: task.model }
        : {}),
      ...(task.origin === "pocketpilot"
        ? { permissionMode: this.permissionModeForTask(task) }
        : {}),
      ...(task.sdkSessionId === null ? {} : { resume: task.sdkSessionId }),
    });
    this.#logger.info(logEvents.sdkQueryStarted, "SDK Query started", {
      origin: task.origin,
      resumed: task.sdkSessionId !== null,
      taskId: task.id,
    });
    liveTask.session = session;
    liveTask.eventLoop = this.consumeSessionEvents(task.id, session);
    return session;
  }

  private executeIdempotent(
    identity: TaskOperationIdentity,
    execute: () => Promise<OperationExecution>,
  ): Promise<TaskOperationResult> {
    const existing = this.#repository.readOperation(
      identity.deviceId,
      identity.operationId,
    );
    if (existing !== undefined) {
      return existing.kind === "result"
        ? Promise.resolve(existing.result)
        : Promise.reject(
            new TaskError(existing.code, existing.statusCode, existing.message),
          );
    }

    const key = `${identity.deviceId}:${identity.operationId}`;
    const inFlight = this.#inFlightOperations.get(key);
    if (inFlight !== undefined) {
      return inFlight;
    }

    let promise: Promise<TaskOperationResult>;
    try {
      promise = execute()
        .then((execution) =>
          this.#repository.persistOperation({
            deviceId: identity.deviceId,
            expiresAt: this.#now() + OPERATION_RESULT_LIFETIME_MILLISECONDS,
            operation: `task.${execution.action}`,
            operationId: identity.operationId,
            result: { action: execution.action, task: execution.task },
            resultLabel: execution.auditResult,
            taskId: execution.task.id,
          }),
        )
        .catch((error: unknown) => {
          if (
            !(error instanceof TaskError) ||
            error.code !== "TASK_OPERATION_SUPERSEDED"
          ) {
            throw error;
          }
          const now = this.#now();
          const outcome = this.#repository.persistSupersededOperation({
            createdAt: now,
            deviceId: identity.deviceId,
            expiresAt: now + OPERATION_RESULT_LIFETIME_MILLISECONDS,
            operationId: identity.operationId,
            taskId: null,
          });
          if (outcome.kind === "result") {
            return outcome.result;
          }
          throw new TaskError(
            outcome.code,
            outcome.statusCode,
            outcome.message,
          );
        });
    } catch (error) {
      return Promise.reject(error);
    }
    this.#inFlightOperations.set(key, promise);
    void promise.then(
      () => {
        this.#inFlightOperations.delete(key);
      },
      () => {
        this.#inFlightOperations.delete(key);
      },
    );
    return promise;
  }

  private isSupportedPermissionMode(
    permissionMode: string,
  ): permissionMode is PermissionMode {
    return this.#supportedPermissionModes.some(
      (supported) => supported === permissionMode,
    );
  }

  private isSupportedEffortLevel(
    effortLevel: string,
  ): effortLevel is EffortLevel {
    return pinnedEffortLevels.some((supported) => supported === effortLevel);
  }

  private liveTask(taskId: string): LiveTask {
    let liveTask = this.#liveTasks.get(taskId);
    if (liveTask === undefined) {
      liveTask = {
        composerInitialized: false,
        closed: false,
        effortLevel: null,
        eventLoop: undefined,
        interrupting: false,
        pendingApproval: undefined,
        pendingQueryCount: 0,
        session: undefined,
        supportedModels: [],
      };
      this.#liveTasks.set(taskId, liveTask);
    }
    return liveTask;
  }

  private parseOperationIdentity(value: unknown): TaskOperationIdentity {
    const parsed = operationIdentitySchema.safeParse(value);
    if (!parsed.success) {
      throw invalidTaskOperationError();
    }
    return parsed.data;
  }

  private permissionModeForTask(task: TaskSnapshot): PermissionMode {
    if (
      task.permissionMode === null ||
      !this.isSupportedPermissionMode(task.permissionMode)
    ) {
      throw new TaskError(
        "UNSUPPORTED_PERMISSION_MODE",
        422,
        "The task's stored Claude permission mode is no longer supported.",
      );
    }
    return task.permissionMode;
  }

  private persistSessionId(taskId: string, session: TaskSdkSession): void {
    const sessionId = session.sessionId;
    if (sessionId === undefined) {
      return;
    }
    const task = this.#repository.find(taskId);
    if (
      task === undefined ||
      task.state === "terminal" ||
      task.sdkSessionId === sessionId
    ) {
      return;
    }
    this.#repository.update(taskId, {
      sdkSessionId: sessionId,
      updatedAt: this.#now(),
    });
    this.#logger.info(
      logEvents.sdkSessionObserved,
      "SDK session reference observed",
      { taskId },
    );
  }

  private registerPendingApproval(
    taskId: string,
    approval: PendingToolApproval,
  ): void {
    const task = this.#repository.find(taskId);
    const liveTask = this.#liveTasks.get(taskId);
    if (
      liveTask === undefined ||
      liveTask.closed ||
      liveTask.interrupting ||
      task === undefined ||
      task.state !== "executing"
    ) {
      approval.cancel("The task is no longer executing.");
      return;
    }
    this.cancelPendingApproval(
      liveTask,
      "A newer tool approval replaced this request.",
    );
    liveTask.pendingApproval = {
      approval,
      requestId: approval.options.requestId,
    };
    const awaitingApproval = this.#repository.update(taskId, {
      state: "awaiting_approval",
      updatedAt: this.#now(),
    });
    this.publishTaskState(awaitingApproval);
    this.#logger.info(
      logEvents.taskApprovalRequested,
      "Task approval requested",
      {
        requestId: approval.options.requestId,
        taskId,
        toolName: approval.toolName,
      },
    );
    const request: SerializableCanUseToolRequest = {
      input: approval.input,
      options: approval.options,
      toolName: approval.toolName,
    };
    this.#eventSink?.publishControlEvent(taskId, {
      kind: "approval.requested",
      payload: request,
    });
  }

  private providerApprovalRequested(
    taskId: string,
    request: ProviderApprovalRequest,
  ): TaskSnapshot | undefined {
    const task = this.#repository.find(taskId);
    if (
      task === undefined ||
      (task.state !== "executing" && task.state !== "awaiting_approval")
    ) {
      return undefined;
    }
    const awaiting =
      task.state === "awaiting_approval"
        ? task
        : this.#repository.update(taskId, {
            state: "awaiting_approval",
            updatedAt: this.#now(),
          });
    if (awaiting !== task) {
      this.publishTaskState(awaiting);
    }
    this.#logger.info(
      logEvents.taskApprovalRequested,
      "Provider approval requested",
      {
        method: request.method,
        provider: request.provider,
        requestId: request.requestId,
        taskId,
      },
    );
    this.#eventSink?.publishControlEvent(taskId, {
      kind: "approval.requested",
      payload: request,
    });
    return awaiting;
  }

  private providerApprovalResolved(
    taskId: string,
    pendingRequestCount: number,
  ): TaskSnapshot | undefined {
    const task = this.#repository.find(taskId);
    if (
      task === undefined ||
      task.state === "interrupted" ||
      task.state === "terminal"
    ) {
      return undefined;
    }
    if (pendingRequestCount === 0 && task.state !== "awaiting_approval") {
      return task;
    }
    const nextState =
      pendingRequestCount > 0 ? "awaiting_approval" : "executing";
    if (task.state === nextState) {
      return task;
    }
    const updated = this.#repository.update(taskId, {
      state: nextState,
      updatedAt: this.#now(),
    });
    this.publishTaskState(updated);
    return updated;
  }

  private async assertProviderTaskReadable(
    taskId: string,
  ): Promise<TaskSnapshot> {
    this.assertAcceptingWork();
    const task = this.requireTask(taskId);
    this.assertTaskNotTerminal(task);
    const liveTask = this.#liveTasks.get(taskId);
    if (
      task.state === "interrupted" ||
      liveTask?.closed === true ||
      liveTask?.interrupting === true
    ) {
      throw new TaskError(
        "TASK_SESSION_UNAVAILABLE",
        409,
        "The task runtime is temporarily unavailable.",
      );
    }
    await this.withCurrentWorkspaceAuthorization(
      task.initialCwd,
      () => undefined,
    );

    this.assertAcceptingWork();
    const current = this.requireTask(taskId);
    this.assertTaskNotTerminal(current);
    if (
      current.state === "interrupted" ||
      this.#liveTasks.get(taskId)?.closed === true ||
      this.#liveTasks.get(taskId)?.interrupting === true
    ) {
      throw new TaskError(
        "TASK_SESSION_UNAVAILABLE",
        409,
        "The task runtime is temporarily unavailable.",
      );
    }
    return current;
  }

  private beginProviderInterrupt(taskId: string): TaskSnapshot {
    const task = this.requireTask(taskId);
    this.assertTaskNotTerminal(task);
    if (task.state === "interrupted") {
      throw interruptedTaskError();
    }
    const liveTask = this.liveTask(taskId);
    liveTask.interrupting = true;
    liveTask.pendingQueryCount = 0;
    this.#taskLanes.get(taskId)?.invalidate();
    this.#providerInterruptTasks.add(taskId);
    this.cancelPendingApproval(liveTask, "The user interrupted this task.");
    const interrupted = this.#repository.update(taskId, {
      interruptedAt: this.#now(),
      state: "interrupted",
      updatedAt: this.#now(),
    });
    this.publishTaskState(interrupted);
    this.#eventSink?.endTurn(taskId);
    return interrupted;
  }

  private completeProviderInterrupt(taskId: string): TaskSnapshot | undefined {
    if (!this.#providerInterruptTasks.delete(taskId)) {
      return this.#repository.find(taskId);
    }
    const liveTask = this.#liveTasks.get(taskId);
    if (liveTask !== undefined) {
      liveTask.interrupting = false;
    }
    const task = this.#repository.find(taskId);
    if (task === undefined || task.state === "terminal") {
      return task;
    }
    const idle = this.#repository.update(taskId, {
      activeTurnId: null,
      interruptedAt: null,
      state: "idle",
      updatedAt: this.#now(),
    });
    this.publishTaskState(idle);
    return idle;
  }

  private reserveProviderTurn(
    taskId: string,
    lease: TaskOperationLease,
  ): Promise<TaskSnapshot> {
    return this.#capacityLane.run(() => {
      lease.assertCurrent();
      this.assertAcceptingWork();
      const task = this.requireTask(taskId);
      this.assertTaskNotTerminal(task);
      if (task.state === "interrupted") {
        throw interruptedTaskError();
      }
      if (task.state !== "idle") {
        return task;
      }
      const settings = readTaskRuntimeSettings(this.#settingsRepository);
      if (
        this.#repository.countActiveTasks() >= settings.concurrentTaskCapacity
      ) {
        throw new TaskError(
          "CONCURRENT_TASK_LIMIT_REACHED",
          409,
          "The configured concurrent-task capacity has been reached.",
        );
      }
      this.#eventSink?.beginTurn(taskId);
      this.#providerTurnReservations.add(taskId);
      const executing = this.#repository.update(taskId, {
        state: "executing",
        updatedAt: this.#now(),
      });
      this.publishTaskState(executing);
      return executing;
    });
  }

  private rollbackProviderTurn(taskId: string): TaskSnapshot | undefined {
    if (!this.#providerTurnReservations.delete(taskId)) {
      return this.#repository.find(taskId);
    }
    const task = this.#repository.find(taskId);
    if (task === undefined || task.state === "terminal") {
      return task;
    }
    const idle = this.#repository.update(taskId, {
      activeTurnId: null,
      state: "idle",
      updatedAt: this.#now(),
    });
    this.publishTaskState(idle);
    this.#eventSink?.endTurn(taskId);
    return idle;
  }

  private startProviderTurn(
    taskId: string,
    nativeTurnId: string,
  ): TaskSnapshot | undefined {
    const task = this.#repository.find(taskId);
    if (task === undefined || task.state === "terminal") {
      return undefined;
    }
    if (task.state === "interrupted") {
      return task;
    }
    this.#providerTurnReservations.delete(taskId);
    if (task.state === "idle") {
      this.#eventSink?.beginTurn(taskId);
    }
    const started = this.#repository.update(taskId, {
      activeTurnId: nativeTurnId,
      state: "executing",
      updatedAt: this.#now(),
    });
    if (task.state !== started.state) {
      this.publishTaskState(started);
    }
    return started;
  }

  private markProviderTaskTerminal(taskId: string): TaskSnapshot | undefined {
    const task = this.#repository.find(taskId);
    if (task === undefined || task.state === "terminal") {
      return task;
    }
    const liveTask = this.#liveTasks.get(taskId);
    if (liveTask !== undefined) {
      liveTask.closed = true;
      liveTask.interrupting = false;
      liveTask.pendingQueryCount = 0;
      this.cancelPendingApproval(
        liveTask,
        "The provider conversation was closed.",
      );
    }
    this.#taskLanes.get(taskId)?.invalidate();
    this.#providerInterruptTasks.delete(taskId);
    this.#providerTurnReservations.delete(taskId);
    const terminal = this.#repository.update(taskId, {
      activeTurnId: null,
      state: "terminal",
      terminalAt: this.#now(),
      updatedAt: this.#now(),
    });
    this.publishTaskState(terminal);
    this.#eventSink?.endTurn(taskId);
    this.#closeTaskAgentConnections.closeTaskConnections(taskId);
    return terminal;
  }

  private completeProviderTurn(taskId: string): TaskSnapshot | undefined {
    if (this.#providerInterruptTasks.has(taskId)) {
      return this.completeProviderInterrupt(taskId);
    }
    this.#providerTurnReservations.delete(taskId);
    const task = this.#repository.find(taskId);
    if (
      task === undefined ||
      task.state === "terminal" ||
      (task.state !== "executing" && task.state !== "awaiting_approval")
    ) {
      return task;
    }
    const idle = this.#repository.update(taskId, {
      activeTurnId: null,
      updatedAt: this.#now(),
      state: "idle",
    });
    this.publishTaskState(idle);
    this.#eventSink?.endTurn(taskId);
    return idle;
  }

  private requireTask(taskId: string): TaskSnapshot {
    const task = this.#repository.find(taskId);
    if (task === undefined) {
      throw new TaskError("TASK_NOT_FOUND", 404, "The task was not found.");
    }
    return task;
  }

  private runTaskLane<T>(
    taskId: string,
    operation: (lease: TaskOperationLease) => Promise<T> | T,
  ): Promise<T> {
    const liveTask = this.liveTask(taskId);
    if (liveTask.closed) {
      throw new TaskError(
        "TASK_TERMINAL",
        409,
        "The task is closed and cannot accept further control operations.",
      );
    }
    if (liveTask.interrupting) {
      throw new TaskError(
        "TASK_SESSION_UNAVAILABLE",
        409,
        "The task is being interrupted and cannot accept new work yet.",
      );
    }
    let lane = this.#taskLanes.get(taskId);
    if (lane === undefined) {
      lane = new TaskOperationScheduler();
      this.#taskLanes.set(taskId, lane);
    }
    return lane.run(operation);
  }

  private runProviderTaskLane<T>(
    taskId: string,
    operation: (lease: TaskOperationLease) => Promise<T> | T,
  ): Promise<T> {
    const task = this.requireTask(taskId);
    this.assertTaskNotTerminal(task);
    if (task.state === "interrupted") {
      throw interruptedTaskError();
    }
    return this.runTaskLane(taskId, operation);
  }

  private runHistoryLane<T>(
    key: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    let lane = this.#historyLanes.get(key);
    if (lane === undefined) {
      lane = new SerialExecutor();
      this.#historyLanes.set(key, lane);
    }
    return lane.run(operation);
  }

  private assertAcceptingWork(): void {
    if (this.#shuttingDown) {
      throw new TaskError(
        "TASK_TERMINAL",
        409,
        "The Agent is shutting down and cannot accept task work.",
      );
    }
  }

  private assertTaskCanAcceptSdkMessage(task: TaskSnapshot): void {
    this.assertTaskNotTerminal(task);
    if (task.state === "interrupted") {
      throw interruptedTaskError();
    }
    const liveTask = this.#liveTasks.get(task.id);
    if (liveTask?.interrupting === true) {
      throw new TaskError(
        "TASK_SESSION_UNAVAILABLE",
        409,
        "The task's Claude SDK session is currently unavailable.",
      );
    }
  }

  private assertClaudeTaskControl(task: TaskSnapshot): void {
    if (task.provider !== "claude") {
      throw new TaskError(
        "TASK_CONTROL_NOT_SUPPORTED",
        409,
        "This task provider requires its native control protocol.",
      );
    }
  }

  private assertTaskId(taskId: string): void {
    if (!taskIdSchema.safeParse(taskId).success) {
      throw invalidTaskOperationError();
    }
  }

  private assertTaskNotTerminal(task: TaskSnapshot): void {
    if (task.state === "terminal") {
      throw new TaskError(
        "TASK_TERMINAL",
        409,
        "The task is closed and cannot accept further control operations.",
      );
    }
  }

  private publishTaskState(task: TaskSnapshot): void {
    const previousState = this.#publishedTaskStates.get(task.id);
    if (previousState !== task.state) {
      this.#logger.info(logEvents.taskStateChanged, "Task state changed", {
        previousState: previousState ?? "unknown",
        state: task.state,
        taskId: task.id,
      });
      this.#publishedTaskStates.set(task.id, task.state);
    }
    this.#eventSink?.publishControlEvent(task.id, {
      kind: "task.state",
      payload: { state: task.state },
    });
  }

  private recordSdkInputAudit(
    deviceId: string,
    taskId: string,
    startsQuery: boolean,
  ): void {
    this.#repository.recordAudit({
      deviceId,
      occurredAt: this.#now(),
      operation: "task.sdk-message-submitted",
      result: startsQuery ? "accepted" : "accepted-without-query",
      taskId,
    });
  }

  private startSdkTurn(
    deviceId: string,
    taskId: string,
    message: SDKUserMessage,
    lease: TaskOperationLease,
  ): TaskSnapshot {
    lease.assertCurrent();
    const task = this.requireTask(taskId);
    this.assertTaskCanAcceptSdkMessage(task);
    if (task.state !== "idle") {
      this.submitToSession(task, message);
      this.liveTask(task.id).pendingQueryCount += 1;
      this.recordSdkInputAudit(deviceId, task.id, true);
      return task;
    }

    const settings = this.#authorizationCoordinator.readTaskRuntimeSettings();
    if (
      this.#repository.countActiveTasks() >= settings.concurrentTaskCapacity
    ) {
      throw new TaskError(
        "CONCURRENT_TASK_LIMIT_REACHED",
        409,
        "The configured concurrent-task capacity has been reached.",
      );
    }

    this.#eventSink?.beginTurn(task.id);
    lease.assertCurrent();
    const executing = this.#repository.update(task.id, {
      state: "executing",
      updatedAt: this.#now(),
    });
    this.#logger.info(logEvents.sdkTurnStarted, "SDK turn started", {
      taskId: task.id,
    });
    try {
      lease.assertCurrent();
      this.submitToSession(executing, message);
    } catch (error) {
      const idle = this.#repository.update(task.id, {
        state: "idle",
        updatedAt: this.#now(),
      });
      this.publishTaskState(idle);
      this.#eventSink?.endTurn(task.id);
      throw error;
    }
    this.liveTask(task.id).pendingQueryCount += 1;
    this.recordSdkInputAudit(deviceId, task.id, true);
    this.publishTaskState(executing);
    return executing;
  }

  private submitToSession(task: TaskSnapshot, message: SDKUserMessage): void {
    try {
      this.ensureSession(task).submit(message);
    } catch (error) {
      if (error instanceof TaskError) {
        throw error;
      }
      throw new TaskError(
        "TASK_SESSION_UNAVAILABLE",
        409,
        "The task's Claude SDK session cannot accept SDK input.",
      );
    }
  }

  private interruptSession(
    session: TaskSdkSession | undefined,
  ): Promise<unknown> | undefined {
    if (session === undefined) {
      return undefined;
    }
    try {
      return session.interrupt();
    } catch {
      return undefined;
    }
  }

  private closeSession(session: TaskSdkSession | undefined): void {
    try {
      session?.close();
    } catch {
      // Closing is best-effort after an explicit interrupt or process shutdown.
    }
  }
}

function readSdkSubtype(message: unknown): string | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("subtype" in message)
  ) {
    return undefined;
  }
  const subtype = Reflect.get(message, "subtype");
  return typeof subtype === "string" ? subtype : undefined;
}

function readSdkUuidPresence(message: unknown): boolean {
  if (typeof message !== "object" || message === null || !("uuid" in message)) {
    return false;
  }
  return typeof Reflect.get(message, "uuid") === "string";
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

function interruptedTaskError(): TaskError {
  return new TaskError(
    "TASK_INTERRUPTED",
    409,
    "The interrupted task must be explicitly resumed before it can continue.",
  );
}

function claudeSessionNotFoundError(): TaskError {
  return new TaskError(
    "CLAUDE_SESSION_NOT_FOUND",
    404,
    "The Claude session was not found in the authorized workspace.",
  );
}

function invalidTaskOperationError(): TaskError {
  return new TaskError(
    "INVALID_TASK_OPERATION",
    422,
    "The task operation is malformed.",
  );
}

function authorizedDirectoryInvalidError(): TaskError {
  return new TaskError(
    "AUTHORIZED_DIRECTORY_INVALID",
    422,
    "The selected path is not an accessible local directory.",
  );
}

function authorizedDirectorySnapshotStaleError(): TaskError {
  return new TaskError(
    "AUTHORIZED_DIRECTORY_SNAPSHOT_STALE",
    409,
    "Authorized directories changed. Refresh and confirm the removal again.",
  );
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function taskSessionUnavailableError(message: string): TaskError {
  return new TaskError("TASK_SESSION_UNAVAILABLE", 409, message);
}
