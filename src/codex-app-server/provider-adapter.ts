import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import type {
  AgentConversationAttachInput,
  AgentConversationHistoryInput,
  AgentConversationListInput,
  AgentConversationOperationInput,
  AgentConversationPage,
  AgentProviderAdapter,
  AgentProviderStatus,
  AgentTaskLifecycleAdapter,
  AgentTaskStreamAdapter,
} from "../agent-providers/types.js";
import type { PocketPilotLogger } from "../logging/logger.js";
import { noopLogger } from "../logging/logger.js";
import { TaskError } from "../tasks/errors.js";
import type { TaskRepository } from "../tasks/task-repository.js";
import type { TaskOperationResult, TaskSnapshot } from "../tasks/task-types.js";
import {
  isPathWithinRoot,
  nodeWorkspaceDirectoryResolver,
  type WorkspaceDirectoryResolver,
} from "../tasks/workspace-path-policy.js";
import {
  type CodexAppServerBridge,
  codexAppServerProtocolVersion,
} from "./bridge.js";
import { CodexNativeJournal } from "./journal.js";
import {
  isCodexClientRequestFrame,
  isForwardedCodexNotification,
  isForwardedCodexServerRequest,
  parseCodexClientFrame,
} from "./protocol.js";
import type {
  CodexBridgeDelivery,
  CodexClientFrame,
  CodexClientRequestFrame,
  CodexJsonObject,
  CodexRequestId,
} from "./types.js";
import { isCodexJsonObject, isCodexRequestId } from "./types.js";

const OPERATION_RESULT_TTL_MS = 24 * 60 * 60 * 1_000;
const CODEX_PROVIDER_ID = "codex";

type CodexRuntime = {
  activated: boolean;
  activation?: Promise<void> | undefined;
  connectionGeneration: number;
  pendingServerRequests: Map<string, string>;
  taskId: string;
  threadId: string;
  workspace: string;
};

type NativeThread = CodexJsonObject & {
  cwd: string;
  id: string;
  sessionId: string;
  turns: unknown[];
};

export type CodexProviderAdapterOptions = {
  bridge: CodexAppServerBridge;
  logger?: PocketPilotLogger;
  now?: () => number;
  repository: TaskRepository;
  status?: AgentProviderStatus;
  statusReasonCode?: string;
  workspaceDirectoryResolver?: WorkspaceDirectoryResolver;
};

/** Implements Codex-native conversation and task behavior over App Server. */
export class CodexProviderAdapter implements AgentProviderAdapter {
  public readonly descriptor;
  public readonly taskLifecycle: AgentTaskLifecycleAdapter;
  public readonly taskStream: AgentTaskStreamAdapter;
  readonly #bridge: CodexAppServerBridge;
  readonly #journal = new CodexNativeJournal();
  readonly #logger: PocketPilotLogger;
  readonly #now: () => number;
  readonly #repository: TaskRepository;
  readonly #runtimes = new Map<string, CodexRuntime>();
  readonly #workspaceDirectoryResolver: WorkspaceDirectoryResolver;
  readonly #unsubscribeBridge: () => void;

  public constructor(options: CodexProviderAdapterOptions) {
    this.#bridge = options.bridge;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? Date.now;
    this.#repository = options.repository;
    this.#workspaceDirectoryResolver =
      options.workspaceDirectoryResolver ?? nodeWorkspaceDirectoryResolver;
    const status = options.status ?? "available";
    this.descriptor = {
      ...(status === "available"
        ? {
            capabilities: {
              activeTurnSteering: true,
              approvals: true,
              attachments: true,
              effort: true,
              historyPagination: "cursor" as const,
              interrupt: true,
              modes: true,
              models: true,
              newConversation: true,
              resumeConversation: true,
              streamProtocol: "codex-app-server-json-rpc" as const,
            },
            protocolVersion: codexAppServerProtocolVersion,
          }
        : {}),
      displayName: "Codex CLI",
      id: CODEX_PROVIDER_ID,
      ...(options.statusReasonCode === undefined
        ? {}
        : { reasonCode: options.statusReasonCode }),
      status,
    };
    this.#unsubscribeBridge = this.#bridge.subscribe((delivery) =>
      this.onBridgeDelivery(delivery),
    );
    this.taskStream = {
      activate: (taskId) => this.activate(taskId),
      parseClientFrame: parseCodexClientFrame,
      submit: (input) => this.submit(input),
      subscribe: (taskId, afterCursor, subscriber) =>
        this.#journal.subscribe(taskId, afterCursor, subscriber),
    };
    this.taskLifecycle = {
      close: (taskId) => this.closeTaskRuntime(taskId),
      interrupt: (taskId) => this.interruptTaskRuntime(taskId),
      resume: (taskId) => this.activate(taskId),
    };
  }

  public async listConversations(
    input: AgentConversationListInput,
  ): Promise<AgentConversationPage<unknown>> {
    const result = requireObject(
      await this.#bridge.request("thread/list", {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        sourceKinds: ["cli", "vscode", "appServer"],
      }),
      "The Codex thread list response is invalid.",
    );
    if (!Array.isArray(result.data)) {
      throw codexHistoryUnavailable();
    }
    const items: unknown[] = [];
    for (const row of result.data) {
      const thread = parseThread(row);
      if (
        thread !== undefined &&
        (await this.isAuthorizedThread(input.workspace, thread))
      ) {
        items.push(row);
      }
    }
    const cursor =
      result.nextCursor === null || typeof result.nextCursor === "string"
        ? result.nextCursor
        : null;
    return { items, page: { cursor, hasMore: cursor !== null } };
  }

  public async readConversation(
    input: AgentConversationHistoryInput,
  ): Promise<AgentConversationPage<unknown>> {
    const thread = await this.requireAuthorizedThread(
      input.workspace,
      input.nativeConversationId,
    );
    const result = requireObject(
      await this.#bridge.request("thread/turns/list", {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        itemsView: "full",
        limit: input.limit ?? 50,
        sortDirection: "desc",
        threadId: thread.id,
      }),
      "The Codex thread history response is invalid.",
    );
    if (!Array.isArray(result.data)) {
      throw codexHistoryUnavailable();
    }
    const cursor =
      result.nextCursor === null || typeof result.nextCursor === "string"
        ? result.nextCursor
        : null;
    return {
      items: [...result.data].reverse(),
      page: { cursor, hasMore: cursor !== null },
    };
  }

  public createConversation(
    input: AgentConversationOperationInput,
  ): Promise<TaskOperationResult> {
    return this.executeOperation(
      input,
      "codex.conversation-created",
      async () => {
        const result = requireObject(
          await this.#bridge.request("thread/start", { cwd: input.workspace }),
          "The Codex thread start response is invalid.",
        );
        const thread = parseThread(result.thread);
        if (
          thread === undefined ||
          !(await this.isAuthorizedThread(input.workspace, thread))
        ) {
          throw codexThreadNotFound();
        }
        const task = this.createTask(input.workspace, thread);
        this.#runtimes.set(task.id, {
          activated: true,
          connectionGeneration: this.#bridge.connectionGeneration,
          pendingServerRequests: new Map(),
          taskId: task.id,
          threadId: thread.id,
          workspace: input.workspace,
        });
        return { action: "created", auditResult: "created", task };
      },
    );
  }

  public attachConversation(
    input: AgentConversationAttachInput,
  ): Promise<TaskOperationResult> {
    return this.executeOperation(
      input,
      "codex.conversation-attached",
      async () => {
        const thread = await this.requireAuthorizedThread(
          input.workspace,
          input.nativeConversationId,
        );
        const existing =
          this.#repository.findNonTerminalByProviderConversationId(
            CODEX_PROVIDER_ID,
            thread.id,
          );
        const task = existing ?? this.createTask(input.workspace, thread);
        this.runtime(task);
        return {
          action: "attached",
          auditResult: existing === undefined ? "attached" : "reused",
          task,
        };
      },
    );
  }

  public async shutdown(): Promise<void> {
    this.#unsubscribeBridge();
    for (const taskId of this.#runtimes.keys()) {
      this.#journal.clear(taskId);
    }
    this.#runtimes.clear();
    await this.#bridge.close();
  }

  private async activate(taskId: string): Promise<void> {
    const task = this.requireCodexTask(taskId);
    const runtime = this.runtime(task);
    await this.#bridge.start();
    if (
      runtime.activated &&
      runtime.connectionGeneration === this.#bridge.connectionGeneration
    ) {
      return;
    }
    runtime.activation ??= this.resumeRuntime(runtime).finally(() => {
      runtime.activation = undefined;
    });
    await runtime.activation;
  }

  private async resumeRuntime(runtime: CodexRuntime): Promise<void> {
    // Approval request IDs belong to one App Server generation. They must not
    // be replayed into a newly initialized process after a bridge failure.
    runtime.pendingServerRequests.clear();
    const result = requireObject(
      await this.#bridge.request("thread/resume", {
        excludeTurns: true,
        threadId: runtime.threadId,
      }),
      "The Codex thread resume response is invalid.",
    );
    const thread = parseThread(result.thread);
    if (
      thread === undefined ||
      thread.id !== runtime.threadId ||
      !(await this.isAuthorizedThread(runtime.workspace, thread))
    ) {
      throw codexThreadNotFound();
    }
    runtime.activated = true;
    runtime.connectionGeneration = this.#bridge.connectionGeneration;
    this.#repository.update(runtime.taskId, {
      activeTurnId: null,
      nativeSessionId: thread.sessionId,
      updatedAt: this.#now(),
    });
  }

  private async submit(input: {
    deviceId: string;
    message: unknown;
    taskId: string;
  }): Promise<TaskSnapshot> {
    const task = this.requireCodexTask(input.taskId);
    const runtime = this.runtime(task);
    await this.activate(task.id);
    const frame = input.message as CodexClientFrame;
    await this.validateRemotePaths(runtime.workspace, frame);
    if (isCodexClientRequestFrame(frame)) {
      const forwarded = this.prepareTaskRequest(runtime, frame);
      await this.#bridge.forward(task.id, forwarded);
      this.#repository.recordAudit({
        deviceId: input.deviceId,
        occurredAt: this.#now(),
        operation: `codex.${forwarded.method}`,
        result: "forwarded",
        taskId: task.id,
      });
      return this.#repository.require(task.id);
    }

    const requestKey = codexRequestKey(frame.id);
    if (!runtime.pendingServerRequests.has(requestKey)) {
      throw new TaskError(
        "STALE_APPROVAL",
        409,
        "The Codex server request is no longer pending for this task.",
      );
    }
    await this.#bridge.respond(frame.id, frame.result);
    runtime.pendingServerRequests.delete(requestKey);
    this.#repository.recordAudit({
      deviceId: input.deviceId,
      occurredAt: this.#now(),
      operation: "codex.server-request-resolved",
      result: "resolved",
      taskId: task.id,
    });
    return this.#repository.require(task.id);
  }

  private prepareTaskRequest(
    runtime: CodexRuntime,
    frame: CodexClientRequestFrame,
  ): CodexClientRequestFrame {
    const params = { ...frame.params };
    const requestedThreadId = params.threadId;
    if (
      requestedThreadId !== undefined &&
      requestedThreadId !== runtime.threadId
    ) {
      throw new TaskError(
        "CODEX_REQUEST_NOT_ALLOWED",
        403,
        "The Codex request does not belong to this task thread.",
      );
    }
    if (frame.method !== "model/list") {
      params.threadId = runtime.threadId;
    }
    const task = this.#repository.require(runtime.taskId);
    if (frame.method === "turn/steer") {
      if (
        task.activeTurnId === null ||
        params.expectedTurnId !== task.activeTurnId
      ) {
        throw new TaskError(
          "TASK_BUSY",
          409,
          "Codex turn steering requires the current active turn id.",
        );
      }
    }
    if (frame.method === "turn/interrupt") {
      if (task.activeTurnId === null || params.turnId !== task.activeTurnId) {
        throw new TaskError(
          "TASK_BUSY",
          409,
          "Codex interruption requires the current active turn id.",
        );
      }
    }
    return { ...frame, params };
  }

  private onBridgeDelivery(delivery: CodexBridgeDelivery): void {
    if (delivery.taskId !== undefined) {
      if (this.#runtimes.has(delivery.taskId)) {
        this.#journal.publish(delivery.taskId, delivery.frame);
      }
      return;
    }
    const method = delivery.frame.method;
    if (typeof method !== "string") {
      return;
    }
    const params = delivery.frame.params;
    const threadId =
      isCodexJsonObject(params) && typeof params.threadId === "string"
        ? params.threadId
        : undefined;
    const runtime =
      threadId === undefined
        ? undefined
        : [...this.#runtimes.values()].find(
            (candidate) => candidate.threadId === threadId,
          );
    if ("id" in delivery.frame && isCodexRequestId(delivery.frame.id)) {
      if (!isForwardedCodexServerRequest(method) || runtime === undefined) {
        void this.#bridge.rejectServerRequest(
          delivery.frame.id,
          "This Codex server request is not allowed by PocketPilot.",
        );
        return;
      }
      void this.acceptServerRequest(runtime, method, {
        ...delivery.frame,
        id: delivery.frame.id,
      });
      return;
    }
    if (!isForwardedCodexNotification(method) || runtime === undefined) {
      return;
    }
    this.applyNotification(runtime, method, params);
    this.#journal.publish(runtime.taskId, delivery.frame);
  }

  private applyNotification(
    runtime: CodexRuntime,
    method: string,
    params: unknown,
  ): void {
    if (!isCodexJsonObject(params)) {
      return;
    }
    const task = this.#repository.find(runtime.taskId);
    if (task === undefined || task.state === "terminal") {
      return;
    }
    if (method === "turn/started") {
      if (task.state === "interrupted") {
        return;
      }
      const turn = params.turn;
      if (isCodexJsonObject(turn) && typeof turn.id === "string") {
        this.#repository.update(runtime.taskId, {
          activeTurnId: turn.id,
          state: "executing",
          updatedAt: this.#now(),
        });
      }
      return;
    }
    if (method === "turn/completed") {
      runtime.pendingServerRequests.clear();
      this.#repository.update(runtime.taskId, {
        activeTurnId: null,
        interruptedAt: null,
        state: "idle",
        updatedAt: this.#now(),
      });
      return;
    }
    if (
      method === "serverRequest/resolved" &&
      isCodexRequestId(params.requestId)
    ) {
      runtime.pendingServerRequests.delete(codexRequestKey(params.requestId));
    }
  }

  private async acceptServerRequest(
    runtime: CodexRuntime,
    method: string,
    frame: CodexJsonObject & { id: CodexRequestId },
  ): Promise<void> {
    try {
      await this.validatePaths(
        runtime.workspace,
        collectNamedAbsolutePaths(frame.params),
      );
    } catch {
      await this.#bridge.rejectServerRequest(
        frame.id,
        "This Codex server request contains an unauthorized path.",
      );
      return;
    }
    if (this.#runtimes.get(runtime.taskId) !== runtime) {
      await this.#bridge.rejectServerRequest(
        frame.id,
        "This Codex server request is no longer attached.",
      );
      return;
    }
    runtime.pendingServerRequests.set(codexRequestKey(frame.id), method);
    this.#journal.publish(runtime.taskId, frame);
  }

  private async closeTaskRuntime(taskId: string): Promise<void> {
    const runtime = this.#runtimes.get(taskId);
    if (runtime === undefined) {
      return;
    }
    runtime.pendingServerRequests.clear();
    try {
      await this.#bridge.request("thread/unsubscribe", {
        threadId: runtime.threadId,
      });
    } finally {
      this.#repository.update(taskId, {
        activeTurnId: null,
        updatedAt: this.#now(),
      });
      this.#journal.clear(taskId);
      this.#runtimes.delete(taskId);
    }
  }

  private async interruptTaskRuntime(taskId: string): Promise<void> {
    const task = this.requireCodexTask(taskId);
    if (task.activeTurnId === null) {
      return;
    }
    await this.#bridge.request("turn/interrupt", {
      threadId: task.nativeConversationId,
      turnId: task.activeTurnId,
    });
    const runtime = this.#runtimes.get(taskId);
    runtime?.pendingServerRequests.clear();
    this.#repository.update(task.id, {
      activeTurnId: null,
      updatedAt: this.#now(),
    });
  }

  private createTask(workspace: string, thread: NativeThread): TaskSnapshot {
    const now = this.#now();
    return this.#repository.create({
      createdAt: now,
      id: randomUUID(),
      initialCwd: workspace,
      model: null,
      nativeConversationId: thread.id,
      nativeProtocolVersion: codexAppServerProtocolVersion,
      nativeSessionId: thread.sessionId,
      origin: "agent-conversation",
      permissionMode: null,
      provider: CODEX_PROVIDER_ID,
    });
  }

  private runtime(task: TaskSnapshot): CodexRuntime {
    let runtime = this.#runtimes.get(task.id);
    if (runtime !== undefined) {
      return runtime;
    }
    if (task.nativeConversationId === null) {
      throw codexThreadNotFound();
    }
    runtime = {
      activated: false,
      connectionGeneration: 0,
      pendingServerRequests: new Map(),
      taskId: task.id,
      threadId: task.nativeConversationId,
      workspace: task.initialCwd,
    };
    this.#runtimes.set(task.id, runtime);
    return runtime;
  }

  private requireCodexTask(taskId: string): TaskSnapshot {
    const task = this.#repository.find(taskId);
    if (task === undefined) {
      throw new TaskError("TASK_NOT_FOUND", 404, "The task does not exist.");
    }
    if (task.provider !== CODEX_PROVIDER_ID || task.state === "terminal") {
      throw new TaskError(
        "TASK_SESSION_UNAVAILABLE",
        409,
        "The Codex task runtime is unavailable.",
      );
    }
    return task;
  }

  private async requireAuthorizedThread(
    workspace: string,
    threadId: string,
  ): Promise<NativeThread> {
    const result = requireObject(
      await this.#bridge.request("thread/read", {
        includeTurns: false,
        threadId,
      }),
      "The Codex thread read response is invalid.",
    );
    const thread = parseThread(result.thread);
    if (
      thread === undefined ||
      thread.id !== threadId ||
      !(await this.isAuthorizedThread(workspace, thread))
    ) {
      throw codexThreadNotFound();
    }
    return thread;
  }

  private async isAuthorizedThread(
    workspace: string,
    thread: NativeThread,
  ): Promise<boolean> {
    try {
      const canonicalCwd =
        await this.#workspaceDirectoryResolver.canonicalizeDirectory(
          thread.cwd,
        );
      return isPathWithinRoot(workspace, canonicalCwd);
    } catch {
      return false;
    }
  }

  private async validateRemotePaths(
    workspace: string,
    frame: CodexClientFrame,
  ): Promise<void> {
    await this.validatePaths(workspace, collectAbsolutePaths(frame));
  }

  private async validatePaths(
    workspace: string,
    paths: readonly string[],
  ): Promise<void> {
    for (const path of paths) {
      let canonicalPath: string;
      try {
        canonicalPath =
          await this.#workspaceDirectoryResolver.canonicalizeDirectory(path);
      } catch {
        throw new TaskError(
          "WORKSPACE_NOT_AUTHORIZED",
          403,
          "A Codex request path is not an authorized directory.",
        );
      }
      if (!isPathWithinRoot(workspace, canonicalPath)) {
        throw new TaskError(
          "WORKSPACE_NOT_AUTHORIZED",
          403,
          "A Codex request path is outside the authorized workspace.",
        );
      }
    }
  }

  private async executeOperation(
    input: AgentConversationOperationInput,
    operation: string,
    run: () => Promise<{
      action: "attached" | "created";
      auditResult: string;
      task: TaskSnapshot;
    }>,
  ): Promise<TaskOperationResult> {
    const existing = this.#repository.readOperation(
      input.deviceId,
      input.operationId,
    );
    if (existing?.kind === "result") {
      return existing.result;
    }
    if (existing?.kind === "error") {
      throw new TaskError(existing.code, existing.statusCode, existing.message);
    }
    const completed = await run();
    return this.#repository.persistOperation({
      deviceId: input.deviceId,
      expiresAt: this.#now() + OPERATION_RESULT_TTL_MS,
      operation,
      operationId: input.operationId,
      result: { action: completed.action, task: completed.task },
      resultLabel: completed.auditResult,
      taskId: completed.task.id,
    });
  }
}

function parseThread(value: unknown): NativeThread | undefined {
  if (
    !isCodexJsonObject(value) ||
    typeof value.id !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.cwd !== "string" ||
    !Array.isArray(value.turns)
  ) {
    return undefined;
  }
  return value as NativeThread;
}

function requireObject(value: unknown, message: string): CodexJsonObject {
  if (!isCodexJsonObject(value)) {
    throw new TaskError("CODEX_APP_SERVER_UNAVAILABLE", 409, message);
  }
  return value;
}

function codexThreadNotFound(): TaskError {
  return new TaskError(
    "CODEX_THREAD_NOT_FOUND",
    404,
    "The Codex thread is unavailable in the selected workspace.",
  );
}

function codexHistoryUnavailable(): TaskError {
  return new TaskError(
    "CODEX_HISTORY_UNAVAILABLE",
    409,
    "Codex thread history is temporarily unavailable.",
  );
}

function codexRequestKey(id: CodexRequestId): string {
  return `${typeof id}:${id}`;
}

function collectAbsolutePaths(frame: CodexClientFrame): string[] {
  const paths: string[] = [];
  const addPath = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (win32.isAbsolute(candidate) || posix.isAbsolute(candidate)) {
        paths.push(candidate);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        addPath(item);
      }
      return;
    }
  };
  if (!isCodexClientRequestFrame(frame)) {
    paths.push(...collectNamedAbsolutePaths(frame.result));
    return paths;
  }
  if (frame.method !== "turn/start" && frame.method !== "turn/steer") {
    return paths;
  }

  const params = frame.params;
  addPath(params.cwd);
  addPath(params.runtimeWorkspaceRoots);
  paths.push(...collectNamedAbsolutePaths(params.environments));
  paths.push(...collectNamedAbsolutePaths(params.sandboxPolicy));
  if (Array.isArray(params.input)) {
    for (const input of params.input) {
      if (
        isCodexJsonObject(input) &&
        (input.type === "localImage" ||
          input.type === "skill" ||
          input.type === "mention")
      ) {
        addPath(input.path);
      }
    }
  }
  return paths;
}

function collectNamedAbsolutePaths(value: unknown): string[] {
  const paths: string[] = [];
  const visit = (candidate: unknown): void => {
    if (!isCodexJsonObject(candidate)) {
      if (Array.isArray(candidate)) {
        for (const child of candidate) {
          visit(child);
        }
      }
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (isPathKey(key)) {
        const candidates = Array.isArray(child) ? child : [child];
        for (const path of candidates) {
          if (
            typeof path === "string" &&
            (win32.isAbsolute(path) || posix.isAbsolute(path))
          ) {
            paths.push(path);
          }
        }
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return paths;
}

function isPathKey(key: string): boolean {
  return /(?:cwd|directory|root|roots|path)$/iu.test(key);
}
