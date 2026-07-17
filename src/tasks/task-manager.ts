import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  PermissionMode,
  PermissionResult,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  createToolApprovalHandler,
  type PendingToolApproval,
  type SerializableCanUseToolRequest,
} from "../claude-sdk/permission-gate.js";
import {
  type ClaudeSdkSession,
  type OpenClaudeSdkSessionOptions,
  openClaudeSdkSession,
  pinnedPermissionModes,
} from "../claude-sdk/session.js";
import type { StorageDatabase } from "../storage/database.js";
import type { SettingsRepository } from "../storage/settings-repository.js";
import { TaskError } from "./errors.js";
import { readTaskRuntimeSettings } from "./settings.js";
import type { TaskEventSink } from "./task-events.js";
import { TaskRepository } from "./task-repository.js";
import type {
  TaskOperationAction,
  TaskOperationResult,
  TaskSnapshot,
} from "./task-types.js";

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

const taskIdSchema = z.uuid();
const deviceIdSchema = z.uuid();

export type TaskOperationIdentity = z.infer<typeof operationIdentitySchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export type TaskPathResolver = {
  canonicalize(path: string): Promise<string>;
};

export type TaskSdkSession = Pick<
  ClaudeSdkSession,
  | "close"
  | "events"
  | "interrupt"
  | "sessionId"
  | "setModel"
  | "setPermissionMode"
  | "submit"
>;

export type TaskSdkSessionFactory = (
  options: OpenClaudeSdkSessionOptions,
) => TaskSdkSession;

export type TaskManagerOptions = {
  createSession?: TaskSdkSessionFactory;
  eventSink?: TaskEventSink;
  now?: () => number;
  pathResolver?: TaskPathResolver;
  settingsRepository: SettingsRepository;
  sqlite: StorageDatabase;
  supportedPermissionModes?: readonly PermissionMode[];
};

type LiveTask = {
  closed: boolean;
  eventLoop: Promise<void> | undefined;
  interrupting: boolean;
  pendingQueryCount: number;
  pendingApproval:
    | { approval: PendingToolApproval; requestId: string }
    | undefined;
  session: TaskSdkSession | undefined;
};

type OperationExecution = {
  action: TaskOperationAction;
  auditResult: string;
  task: TaskSnapshot;
};

/**
 * Serializes per-task controls, owns only live SDK resources, and persists
 * task/session metadata. It deliberately never stores SDK input or output:
 * the SDK remains the canonical conversation owner.
 */
export class TaskManager {
  readonly #capacityLane = new SerialExecutor();
  readonly #createSession: TaskSdkSessionFactory;
  readonly #eventSink: TaskEventSink | undefined;
  readonly #inFlightOperations = new Map<
    string,
    Promise<TaskOperationResult>
  >();
  readonly #liveTasks = new Map<string, LiveTask>();
  readonly #now: () => number;
  readonly #pathResolver: TaskPathResolver;
  readonly #repository: TaskRepository;
  readonly #settingsRepository: SettingsRepository;
  readonly #supportedPermissionModes: readonly PermissionMode[];
  readonly #taskLanes = new Map<string, SerialExecutor>();
  #shuttingDown = false;

  public constructor(options: TaskManagerOptions) {
    this.#createSession = options.createSession ?? openClaudeSdkSession;
    this.#eventSink = options.eventSink;
    this.#now = options.now ?? Date.now;
    this.#pathResolver = options.pathResolver ?? nodeTaskPathResolver;
    this.#repository = new TaskRepository(options.sqlite);
    this.#settingsRepository = options.settingsRepository;
    this.#supportedPermissionModes =
      options.supportedPermissionModes ?? pinnedPermissionModes;
  }

  /** Converts unfinished active work from a prior unexpected exit to interrupted. */
  public recoverFromUnexpectedRestart(): number {
    return this.#repository.markActiveTasksInterrupted(this.#now());
  }

  public listTasks(): TaskSnapshot[] {
    return this.#repository.list();
  }

  public supportedPermissionModes(): readonly PermissionMode[] {
    return this.#supportedPermissionModes;
  }

  public getTask(taskId: string): TaskSnapshot {
    this.assertTaskId(taskId);
    return this.requireTask(taskId);
  }

  public async createTask(
    input: CreateTaskInput,
  ): Promise<TaskOperationResult> {
    const parsed = createTaskInputSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidTaskOperationError();
    }
    if (!parsed.data.workspaceRiskAccepted) {
      throw new TaskError(
        "WORKSPACE_SCOPE_RISK_NOT_ACCEPTED",
        422,
        "Task creation requires accepting the workspace scope risk.",
      );
    }
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

        const initialCwd = await this.authorizeInitialWorkspace(
          parsed.data.initialCwd,
          settings.workspaceRoots,
        );
        const now = this.#now();
        const task = this.#repository.create({
          createdAt: now,
          id: randomUUID(),
          initialCwd,
          model: parsed.data.model ?? null,
          permissionMode: parsed.data.permissionMode,
        });
        return {
          action: "created",
          auditResult: "workspace-risk-accepted",
          task,
        };
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

    return this.runTaskLane(input.taskId, async () => {
      this.assertAcceptingWork();
      const task = this.requireTask(input.taskId);
      this.assertTaskCanAcceptSdkMessage(task);
      const startsQuery = input.message.shouldQuery !== false;

      if (task.state === "idle" && startsQuery) {
        return this.#capacityLane.run(() =>
          this.startSdkTurn(input.deviceId, task.id, input.message),
        );
      }

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
      this.cancelPendingApproval(liveTask, "The user interrupted this task.");
      liveTask.pendingQueryCount = 0;
      liveTask.interrupting = true;

      try {
        await liveTask.session?.interrupt();
      } finally {
        liveTask.interrupting = false;
      }

      const current = this.requireTask(task.id);
      const updated =
        current.state === "terminal"
          ? current
          : this.#repository.update(task.id, {
              state: "idle",
              updatedAt: this.#now(),
            });
      this.publishTaskState(updated);
      this.#eventSink?.endTurn(task.id);
      return {
        action: "interrupted",
        auditResult: current.state === "idle" ? "already-idle" : "interrupted",
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
      this.cancelPendingApproval(liveTask, "The user closed this task.");
      liveTask.pendingQueryCount = 0;
      const terminal = this.#repository.update(task.id, {
        state: "terminal",
        terminalAt: this.#now(),
        updatedAt: this.#now(),
      });
      this.publishTaskState(terminal);
      this.#eventSink?.endTurn(task.id);
      const interrupt = this.interruptSession(liveTask.session);
      this.closeSession(liveTask.session);
      await Promise.allSettled(interrupt === undefined ? [] : [interrupt]);
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
      this.runTaskLane(input.taskId, () => {
        this.assertAcceptingWork();
        const task = this.requireTask(input.taskId);
        if (task.state !== "interrupted") {
          throw new TaskError(
            "TASK_BUSY",
            409,
            "Only an interrupted task can be resumed.",
          );
        }
        if (task.sdkSessionId === null) {
          throw new TaskError(
            "TASK_SESSION_UNAVAILABLE",
            409,
            "The interrupted task has no saved Claude session reference.",
          );
        }

        this.ensureSession(task);
        const resumed = this.#repository.update(task.id, {
          state: "idle",
          updatedAt: this.#now(),
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
      this.runTaskLane(input.taskId, () => {
        const task = this.requireTask(input.taskId);
        this.assertTaskNotTerminal(task);
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

        pending.approval.resolve(input.result);
        liveTask.pendingApproval = undefined;
        const executing = this.#repository.update(task.id, {
          state: "executing",
          updatedAt: this.#now(),
        });
        this.publishTaskState(executing);
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
      this.runTaskLane(input.taskId, async () => {
        const task = this.requireTask(input.taskId);
        this.assertTaskNotTerminal(task);
        if (task.state === "interrupted") {
          throw interruptedTaskError();
        }
        if (task.state !== "idle") {
          throw taskBusyError();
        }

        const liveTask = this.liveTask(task.id);
        if (liveTask.session !== undefined) {
          await liveTask.session.setModel(input.model);
        }
        const current = this.requireTask(task.id);
        if (current.state === "terminal") {
          return {
            action: "model-changed",
            auditResult: "task-closed",
            task: current,
          };
        }
        const updated = this.#repository.update(task.id, {
          model: input.model ?? null,
          updatedAt: this.#now(),
        });
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
      this.runTaskLane(input.taskId, async () => {
        const task = this.requireTask(input.taskId);
        this.assertTaskNotTerminal(task);
        if (task.state === "interrupted") {
          throw interruptedTaskError();
        }

        const liveTask = this.liveTask(task.id);
        if (liveTask.session !== undefined) {
          await liveTask.session.setPermissionMode(permissionMode);
        }
        const current = this.requireTask(task.id);
        if (current.state === "terminal") {
          return {
            action: "permission-mode-changed",
            auditResult: "task-closed",
            task: current,
          };
        }
        const updated = this.#repository.update(task.id, {
          permissionMode,
          updatedAt: this.#now(),
        });
        return {
          action: "permission-mode-changed",
          auditResult: "changed",
          task: updated,
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

    const interruptions: Promise<unknown>[] = [];
    for (const [taskId, liveTask] of this.#liveTasks) {
      liveTask.closed = true;
      this.cancelPendingApproval(liveTask, "The Agent is shutting down.");
      liveTask.pendingQueryCount = 0;
      this.#eventSink?.endTurn(taskId);
      if (liveTask.session !== undefined) {
        const interrupt = this.interruptSession(liveTask.session);
        if (interrupt !== undefined) {
          interruptions.push(interrupt);
        }
        this.closeSession(liveTask.session);
      }
    }
    await Promise.allSettled(interruptions);
    this.#repository.markNonTerminalTasksTerminal(this.#now());
    this.#liveTasks.clear();
  }

  private async authorizeInitialWorkspace(
    requestedCwd: string,
    configuredRoots: readonly string[],
  ): Promise<string> {
    let cwd: string;
    try {
      cwd = await this.#pathResolver.canonicalize(requestedCwd);
    } catch {
      throw new TaskError(
        "WORKSPACE_NOT_AUTHORIZED",
        403,
        "The requested working directory is not an authorized workspace.",
      );
    }

    for (const configuredRoot of configuredRoots) {
      try {
        const root = await this.#pathResolver.canonicalize(configuredRoot);
        if (isPathWithinRoot(root, cwd)) {
          return cwd;
        }
      } catch {
        // A removed or inaccessible configured root cannot authorize work.
      }
    }
    throw new TaskError(
      "WORKSPACE_NOT_AUTHORIZED",
      403,
      "The requested working directory is not an authorized workspace.",
    );
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
          this.persistSessionId(taskId, session);
          this.#eventSink?.publishSdkMessage(taskId, message);
          if (message.type === "result") {
            this.completeActiveTurn(taskId, false);
          } else if (
            message.type === "system" &&
            message.subtype === "session_state_changed" &&
            message.state === "idle"
          ) {
            this.completeActiveTurn(taskId, true);
          }
        }
      } catch {
        this.completeActiveTurn(taskId, true);
      } finally {
        const liveTask = this.#liveTasks.get(taskId);
        if (liveTask?.session === session) {
          liveTask.session = undefined;
          liveTask.eventLoop = undefined;
        }
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

    const permissionMode = this.permissionModeForTask(task);
    const session = this.#createSession({
      canUseTool: createToolApprovalHandler((approval) => {
        this.registerPendingApproval(task.id, approval);
      }),
      cwd: task.initialCwd,
      ...(task.model === null ? {} : { model: task.model }),
      permissionMode,
      ...(task.sdkSessionId === null ? {} : { resume: task.sdkSessionId }),
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
      return Promise.resolve(existing);
    }

    const key = `${identity.deviceId}:${identity.operationId}`;
    const inFlight = this.#inFlightOperations.get(key);
    if (inFlight !== undefined) {
      return inFlight;
    }

    let promise: Promise<TaskOperationResult>;
    try {
      promise = execute().then((execution) =>
        this.#repository.persistOperation({
          deviceId: identity.deviceId,
          expiresAt: this.#now() + OPERATION_RESULT_LIFETIME_MILLISECONDS,
          operation: `task.${execution.action}`,
          operationId: identity.operationId,
          result: { action: execution.action, task: execution.task },
          resultLabel: execution.auditResult,
          taskId: execution.task.id,
        }),
      );
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

  private liveTask(taskId: string): LiveTask {
    let liveTask = this.#liveTasks.get(taskId);
    if (liveTask === undefined) {
      liveTask = {
        closed: false,
        eventLoop: undefined,
        interrupting: false,
        pendingApproval: undefined,
        pendingQueryCount: 0,
        session: undefined,
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
    if (!this.isSupportedPermissionMode(task.permissionMode)) {
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

  private requireTask(taskId: string): TaskSnapshot {
    const task = this.#repository.find(taskId);
    if (task === undefined) {
      throw new TaskError("TASK_NOT_FOUND", 404, "The task was not found.");
    }
    return task;
  }

  private runTaskLane<T>(
    taskId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    let lane = this.#taskLanes.get(taskId);
    if (lane === undefined) {
      lane = new SerialExecutor();
      this.#taskLanes.set(taskId, lane);
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
  ): TaskSnapshot {
    const task = this.requireTask(taskId);
    this.assertTaskCanAcceptSdkMessage(task);
    if (task.state !== "idle") {
      this.submitToSession(task, message);
      this.liveTask(task.id).pendingQueryCount += 1;
      this.recordSdkInputAudit(deviceId, task.id, true);
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

    this.#eventSink?.beginTurn(task.id);
    const executing = this.#repository.update(task.id, {
      state: "executing",
      updatedAt: this.#now(),
    });
    try {
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

const nodeTaskPathResolver: TaskPathResolver = {
  async canonicalize(path: string): Promise<string> {
    return realpath(resolve(path));
  },
};

function interruptedTaskError(): TaskError {
  return new TaskError(
    "TASK_INTERRUPTED",
    409,
    "The interrupted task must be explicitly resumed before it can continue.",
  );
}

function invalidTaskOperationError(): TaskError {
  return new TaskError(
    "INVALID_TASK_OPERATION",
    422,
    "The task operation is malformed.",
  );
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function taskBusyError(): TaskError {
  return new TaskError(
    "TASK_BUSY",
    409,
    "The task is busy; interrupt the current turn before sending new work.",
  );
}
