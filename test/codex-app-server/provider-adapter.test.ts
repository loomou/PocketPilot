import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerBridge } from "../../src/codex-app-server/bridge.js";
import { CodexProviderAdapter } from "../../src/codex-app-server/provider-adapter.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";
import type { ProviderTaskRuntime } from "../../src/tasks/provider-task-runtime.js";
import {
  writeTaskCapacitySettings,
  writeTaskRuntimeSettings,
} from "../../src/tasks/settings.js";
import { TaskEventJournal } from "../../src/tasks/task-event-journal.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { TaskRepository } from "../../src/tasks/task-repository.js";

class FakeCodexProcess extends EventEmitter {
  public errorAfterTurnStarted = false;
  public failInterrupts = false;
  public failTurnStarts = false;
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public turnStartedBeforeResponse = false;
  public readonly writes: Record<string, unknown>[] = [];
  private nextThread = 1;

  public constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      const frame = JSON.parse(chunk.toString("utf8")) as Record<
        string,
        unknown
      >;
      this.writes.push(frame);
      if (frame.method === "initialize") {
        this.emitFrame({
          id: frame.id,
          result: {
            platformFamily: "windows",
            platformOs: "windows",
            userAgent: "pocketpilot/0.144.6 (Windows)",
          },
        });
      }
      if (frame.method === "thread/start") {
        this.emitFrame({
          id: frame.id,
          result: { thread: thread(`thread-${this.nextThread++}`) },
        });
      }
      if (frame.method === "thread/read" || frame.method === "thread/resume") {
        const params = frame.params as { threadId?: unknown } | undefined;
        const threadId =
          typeof params?.threadId === "string" ? params.threadId : "thread-1";
        this.emitFrame({ id: frame.id, result: { thread: thread(threadId) } });
      }
      if (frame.method === "thread/list") {
        this.emitFrame({
          id: frame.id,
          result: { backwardsCursor: null, data: [thread()], nextCursor: null },
        });
      }
      if (frame.method === "thread/fork") {
        const params = frame.params as { threadId?: unknown } | undefined;
        const sourceId =
          typeof params?.threadId === "string" ? params.threadId : "thread-1";
        this.emitFrame({
          id: frame.id,
          result: {
            thread: thread(`thread-${this.nextThread++}`, {
              forkedFrom: sourceId,
            }),
          },
        });
      }
      if (frame.method === "thread/archive") {
        this.emitFrame({ id: frame.id, result: {} });
      }
      if (frame.method === "thread/unarchive") {
        this.emitFrame({ id: frame.id, result: {} });
      }
      if (frame.method === "thread/delete") {
        this.emitFrame({ id: frame.id, result: {} });
      }
      if (frame.method === "account/read") {
        this.emitFrame({
          id: frame.id,
          result: {
            account: {
              email: "user@example.com",
              planType: "pro",
              refreshToken: "secret-token",
              type: "chatgpt",
            },
            requiresOpenaiAuth: true,
          },
        });
      }
      if (frame.method === "account/rateLimits/read") {
        this.emitFrame({
          id: frame.id,
          result: {
            rateLimits: {
              limit_id: "primary",
              plan_type: "pro",
              primary: { used_percent: 12 },
              secretQuotaToken: "quota-secret",
            },
          },
        });
      }
      if (frame.method === "skills/list") {
        this.emitFrame({
          id: frame.id,
          result: {
            data: [
              {
                description: "Review helper",
                enabled: true,
                metadata: {
                  description: "Review helper",
                  name: "review",
                  path: "C:\\skills\\review",
                },
                name: "review",
                path: "C:\\skills\\review",
                scope: "repo",
              },
            ],
            errors: [
              {
                message: "bad skill",
                path: "C:\\skills\\broken",
                scope: "user",
              },
            ],
          },
        });
      }
      if (frame.method === "hooks/list") {
        this.emitFrame({
          id: frame.id,
          result: {
            data: [
              {
                description: "pre tool",
                enabled: true,
                hooks: ["PreToolUse"],
                metadata: {
                  hooks: ["PreToolUse"],
                  name: "guard",
                  path: "C:\\hooks\\guard",
                },
                name: "guard",
                path: "C:\\hooks\\guard",
                scope: "user",
              },
            ],
          },
        });
      }
      if (frame.method === "mcpServerStatus/list") {
        this.emitFrame({
          id: frame.id,
          result: {
            data: [
              {
                authStatus: "unsupported",
                command: "npx",
                name: "demo",
                tools: [
                  {
                    description: "demo tool",
                    name: "echo",
                  },
                ],
              },
            ],
          },
        });
      }
      if (frame.method === "thread/turns/list") {
        this.emitFrame({
          id: frame.id,
          result: {
            backwardsCursor: null,
            data: [{ id: "turn-1", items: [], status: "completed" }],
            nextCursor: null,
          },
        });
      }
      if (frame.method === "thread/unsubscribe") {
        this.emitFrame({ id: frame.id, result: {} });
      }
      if (frame.method === "turn/interrupt") {
        this.emitFrame(
          this.failInterrupts
            ? {
                error: { code: -32_000, message: "interrupt rejected" },
                id: frame.id,
              }
            : { id: frame.id, result: {} },
        );
      }
      if (
        frame.method === "turn/start" ||
        frame.method === "review/start" ||
        frame.method === "thread/compact/start"
      ) {
        if (this.failTurnStarts) {
          this.emitFrame({
            error: { code: -32_000, message: "turn start rejected" },
            id: frame.id,
          });
          return;
        }
        const params = frame.params as { threadId?: unknown } | undefined;
        const threadId =
          typeof params?.threadId === "string" ? params.threadId : "thread-1";
        const turnId =
          frame.method === "review/start"
            ? "review-turn-1"
            : frame.method === "thread/compact/start"
              ? "compact-turn-1"
              : "turn-1";
        const started = {
          method: "turn/started",
          params: { threadId, turn: { id: turnId } },
        };
        if (this.turnStartedBeforeResponse || this.errorAfterTurnStarted) {
          this.emitFrame(started);
        }
        if (this.errorAfterTurnStarted) {
          this.emitFrame({
            error: { code: -32_000, message: "late turn start rejection" },
            id: frame.id,
          });
          return;
        }
        this.emitFrame({ id: frame.id, result: { turn: { id: turnId } } });
        if (!this.turnStartedBeforeResponse) {
          this.emitFrame(started);
        }
      }
      if (frame.method === "thread/name/set") {
        const params = frame.params as
          | { name?: unknown; threadId?: unknown }
          | undefined;
        const threadId =
          typeof params?.threadId === "string" ? params.threadId : "thread-1";
        const name = typeof params?.name === "string" ? params.name : "renamed";
        this.emitFrame({ id: frame.id, result: {} });
        this.emitFrame({
          method: "thread/name/updated",
          params: { name, threadId },
        });
      }
    });
  }

  public kill(): boolean {
    this.emit("close", 0, null);
    return true;
  }

  public emitFrame(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}

const deviceId = "00000000-0000-4000-8000-000000000010";
const workspace = "C:\\workspace";

function requireNativeConversationId(
  task: import("../../src/tasks/task-types.js").TaskSnapshot,
): string {
  if (task.nativeConversationId === null) {
    throw new Error("expected nativeConversationId");
  }
  return task.nativeConversationId;
}

function requireTaskResult(result: {
  action: string;
  task: import("../../src/tasks/task-types.js").TaskSnapshot | null;
}): import("../../src/tasks/task-types.js").TaskSnapshot {
  if (result.task === null) {
    throw new Error(`expected task for action ${result.action}`);
  }
  return result.task;
}

describe("CodexProviderAdapter", () => {
  const connections: StorageConnection[] = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
  });

  it("creates, lists, reads, and reuses native Codex threads", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    connection.sqlite
      .prepare(
        "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(deviceId, "test", "public", 1);
    const process = new FakeCodexProcess();
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: createTaskRuntime(connection),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });

    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000011",
      workspace,
      workspaceRiskAccepted: true,
    });
    expect(created.action).toBe("created");
    expect(requireTaskResult(created).provider).toBe("codex");
    expect(requireTaskResult(created).nativeConversationId).toBe("thread-1");
    expect(requireTaskResult(created).nativeSessionId).toBe("session-1");

    await expect(
      adapter.listConversations({ workspace, limit: 50 }),
    ).resolves.toEqual({
      items: [thread()],
      page: { cursor: null, hasMore: false },
    });
    await expect(
      adapter.readConversation({
        nativeConversationId: "thread-1",
        workspace,
      }),
    ).resolves.toEqual({
      items: [{ id: "turn-1", items: [], status: "completed" }],
      page: { cursor: null, hasMore: false },
    });

    const attached = await adapter.attachConversation({
      deviceId,
      nativeConversationId: "thread-1",
      operationId: "00000000-0000-4000-8000-000000000012",
      workspace,
      workspaceRiskAccepted: true,
    });
    expect(attached.action).toBe("attached");
    expect(requireTaskResult(attached).id).toBe(requireTaskResult(created).id);
    await adapter.shutdown();
  });

  it("forwards list filters and forks, archives, unarchives, and deletes threads", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const repository = new TaskRepository(connection.database);
    const taskManager = createTaskManager(connection);
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository,
      taskRuntime: taskManager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });

    await adapter.listConversations({
      includeArchived: true,
      searchTerm: "review",
      workspace,
    });
    const listWrite = process.writes.find(
      (frame) => frame.method === "thread/list",
    );
    expect(listWrite?.params).toMatchObject({
      archived: true,
      searchTerm: "review",
      sourceKinds: ["cli", "vscode", "appServer"],
    });

    const forked = await adapter.forkConversation({
      deviceId,
      nativeConversationId: "thread-1",
      operationId: "00000000-0000-4000-8000-000000000031",
      workspace,
      workspaceRiskAccepted: true,
    });
    expect(forked.action).toBe("forked");
    expect(requireTaskResult(forked).nativeConversationId).toMatch(/^thread-/);
    expect(process.writes.some((frame) => frame.method === "thread/fork")).toBe(
      true,
    );

    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000032",
      workspace,
      workspaceRiskAccepted: true,
    });
    const createdTask = requireTaskResult(created);
    await expect(
      adapter.archiveConversation({
        confirm: false,
        deviceId,
        nativeConversationId: requireNativeConversationId(createdTask),
        operationId: "00000000-0000-4000-8000-000000000033",
        workspace,
        workspaceRiskAccepted: true,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED", statusCode: 409 });
    await expect(
      adapter.archiveConversation({
        deviceId,
        nativeConversationId: requireNativeConversationId(createdTask),
        operationId: "00000000-0000-4000-8000-000000000039",
        workspace,
        workspaceRiskAccepted: true,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED", statusCode: 409 });

    const archived = await adapter.archiveConversation({
      confirm: true,
      deviceId,
      nativeConversationId: requireNativeConversationId(createdTask),
      operationId: "00000000-0000-4000-8000-000000000040",
      workspace,
      workspaceRiskAccepted: true,
    });
    expect(archived).toEqual({ action: "archived", task: null });
    expect(repository.find(createdTask.id)?.state).not.toBe("terminal");

    const unarchived = await adapter.unarchiveConversation({
      deviceId,
      nativeConversationId: requireNativeConversationId(createdTask),
      operationId: "00000000-0000-4000-8000-000000000034",
      workspace,
      workspaceRiskAccepted: true,
    });
    expect(unarchived).toEqual({ action: "unarchived", task: null });

    const deleted = await adapter.deleteConversation({
      confirm: true,
      deviceId,
      nativeConversationId: requireNativeConversationId(createdTask),
      operationId: "00000000-0000-4000-8000-000000000035",
      workspace,
      workspaceRiskAccepted: true,
    });
    expect(deleted).toEqual({ action: "deleted", task: null });
    expect(
      process.writes.some((frame) => frame.method === "thread/delete"),
    ).toBe(true);
    expect(repository.find(createdTask.id)?.state).toBe("terminal");

    await expect(
      adapter.deleteConversation({
        confirm: false,
        deviceId,
        nativeConversationId: "thread-1",
        operationId: "00000000-0000-4000-8000-000000000037",
        workspace,
        workspaceRiskAccepted: true,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED", statusCode: 409 });

    await expect(
      adapter.deleteConversation({
        deviceId,
        nativeConversationId: "thread-1",
        operationId: "00000000-0000-4000-8000-000000000038",
        workspace,
        workspaceRiskAccepted: true,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED", statusCode: 409 });

    await adapter.shutdown();
  });

  it("routes native server approvals to only the owning task", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    connection.sqlite
      .prepare(
        "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(deviceId, "test", "public", 1);
    const process = new FakeCodexProcess();
    const eventJournal = new TaskEventJournal({
      masterKey: Buffer.alloc(32, 1),
      sqlite: connection.sqlite,
    });
    const taskManager = createTaskManager(connection, eventJournal);
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: taskManager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000013",
      workspace,
      workspaceRiskAccepted: true,
    });
    const received: unknown[] = [];
    const controlEvents: unknown[] = [];
    eventJournal.subscribeControl(requireTaskResult(created).id, -1, {
      send(event) {
        controlEvents.push(event);
      },
    });
    const unsubscribe = adapter.taskStream.subscribe(
      requireTaskResult(created).id,
      undefined,
      {
        send(frame) {
          received.push(frame);
        },
      },
    );
    await adapter.taskStream.activate(requireTaskResult(created).id);
    const turnStart = adapter.taskStream.parseClientFrame(
      JSON.stringify({
        id: "turn-start",
        method: "turn/start",
        params: { input: [] },
      }),
      false,
    );
    await adapter.taskStream.submit({
      deviceId,
      message: turnStart,
      taskId: requireTaskResult(created).id,
    });
    process.emitFrame({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "git status", threadId: "thread-1", turnId: "turn-1" },
    });
    process.emitFrame({
      id: "approval-2",
      method: "item/fileChange/requestApproval",
      params: { itemId: "item-2", threadId: "thread-1", turnId: "turn-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toContainEqual({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "git status", threadId: "thread-1", turnId: "turn-1" },
    });
    expect(taskManager.getTask(requireTaskResult(created).id).state).toBe(
      "awaiting_approval",
    );
    expect(controlEvents).toContainEqual(
      expect.objectContaining({
        event: {
          kind: "approval.requested",
          payload: {
            method: "item/commandExecution/requestApproval",
            params: {
              command: "git status",
              threadId: "thread-1",
              turnId: "turn-1",
            },
            provider: "codex",
            requestId: "approval-1",
          },
        },
        taskId: requireTaskResult(created).id,
      }),
    );

    const response = adapter.taskStream.parseClientFrame(
      JSON.stringify({ id: "approval-1", result: { decision: "accept" } }),
      false,
    );
    expect(response).toBeDefined();
    await expect(
      adapter.taskStream.submit({
        deviceId: "00000000-0000-4000-8000-000000000099",
        message: response,
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
    await adapter.taskStream.submit({
      deviceId,
      message: response,
      taskId: requireTaskResult(created).id,
    });
    expect(process.writes).toContainEqual({
      id: "approval-1",
      result: { decision: "accept" },
    });
    expect(taskManager.getTask(requireTaskResult(created).id).state).toBe(
      "awaiting_approval",
    );
    expect(received).toContainEqual({
      id: "approval-2",
      method: "item/fileChange/requestApproval",
      params: { itemId: "item-2", threadId: "thread-1", turnId: "turn-1" },
    });
    const secondResponse = adapter.taskStream.parseClientFrame(
      JSON.stringify({ id: "approval-2", result: { decision: "decline" } }),
      false,
    );
    expect(secondResponse).toBeDefined();
    await adapter.taskStream.submit({
      deviceId,
      message: secondResponse,
      taskId: requireTaskResult(created).id,
    });
    expect(process.writes).toContainEqual({
      id: "approval-2",
      result: { decision: "decline" },
    });
    expect(taskManager.getTask(requireTaskResult(created).id).state).toBe(
      "executing",
    );
    process.emitFrame({
      id: "approval-outside",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "git status",
        cwd: "D:\\outside",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      received.some(
        (frame) =>
          typeof frame === "object" &&
          frame !== null &&
          "id" in frame &&
          frame.id === "approval-outside",
      ),
    ).toBe(false);
    expect(process.writes).toContainEqual({
      error: {
        code: -32_601,
        message: "This Codex server request contains an unauthorized path.",
      },
      id: "approval-outside",
    });
    unsubscribe();
    await adapter.shutdown();
  });

  it("resumes the native thread after the bridge reconnects", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    connection.sqlite
      .prepare(
        "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(deviceId, "test", "public", 1);
    const first = new FakeCodexProcess();
    const second = new FakeCodexProcess();
    const processes = [first, second];
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => processes.shift() ?? second,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: createTaskRuntime(connection),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000014",
      workspace,
      workspaceRiskAccepted: true,
    });

    first.emit("close", 1, null);
    await adapter.taskStream.activate(requireTaskResult(created).id);

    expect(second.writes.map((frame) => frame.method)).toContain(
      "thread/resume",
    );
    await adapter.shutdown();
  });

  it("does not send an interrupt for a stale turn after bridge reconnect", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const first = new FakeCodexProcess();
    const second = new FakeCodexProcess();
    const processes = [first, second];
    const manager = createTaskManager(connection);
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => processes.shift() ?? second,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000017",
      workspace,
      workspaceRiskAccepted: true,
    });
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "turn-before-interrupt-reconnect",
        method: "turn/start",
        params: { input: [] },
      }),
      taskId: requireTaskResult(created).id,
    });
    first.emit("close", 1, null);

    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "stale-interrupt",
          method: "turn/interrupt",
          params: { turnId: "turn-1" },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "TASK_BUSY" });
    expect(second.writes.map((frame) => frame.method)).toContain(
      "thread/resume",
    );
    expect(second.writes.map((frame) => frame.method)).not.toContain(
      "turn/interrupt",
    );
    expect(manager.getTask(requireTaskResult(created).id).state).toBe("idle");

    await manager.shutdown();
    await adapter.shutdown();
  });

  it("does not reuse approvals from a previous bridge generation", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    connection.sqlite
      .prepare(
        "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(deviceId, "test", "public", 1);
    const first = new FakeCodexProcess();
    const second = new FakeCodexProcess();
    const processes = [first, second];
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => processes.shift() ?? second,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: createTaskRuntime(connection),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000016",
      workspace,
      workspaceRiskAccepted: true,
    });
    await adapter.taskStream.activate(requireTaskResult(created).id);
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "turn-before-reconnect",
        method: "turn/start",
        params: { input: [] },
      }),
      taskId: requireTaskResult(created).id,
    });
    first.emitFrame({
      id: "approval-old",
      method: "item/commandExecution/requestApproval",
      params: { command: "git status", threadId: "thread-1", turnId: "turn-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    first.emit("close", 1, null);
    await adapter.taskStream.activate(requireTaskResult(created).id);

    const staleResponse = adapter.taskStream.parseClientFrame(
      JSON.stringify({ id: "approval-old", result: { decision: "accept" } }),
      false,
    );
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: staleResponse,
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
    await adapter.shutdown();
  });

  it("validates path fields without interpreting paths inside prompt text", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    connection.sqlite
      .prepare(
        "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(deviceId, "test", "public", 1);
    const process = new FakeCodexProcess();
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: createTaskRuntime(connection),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000015",
      workspace,
      workspaceRiskAccepted: true,
    });
    const promptFrame = adapter.taskStream.parseClientFrame(
      JSON.stringify({
        id: "turn-prompt-path",
        method: "turn/start",
        params: {
          input: [
            {
              text: "Explain why D:\\examples\\file.txt is absolute.",
              type: "text",
            },
          ],
        },
      }),
      false,
    );
    expect(promptFrame).toBeDefined();
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: promptFrame,
        taskId: requireTaskResult(created).id,
      }),
    ).resolves.toMatchObject({ id: requireTaskResult(created).id });

    const outsideWorkspaceFrame = adapter.taskStream.parseClientFrame(
      JSON.stringify({
        id: "turn-outside-workspace",
        method: "turn/start",
        params: { cwd: "D:\\outside", input: [] },
      }),
      false,
    );
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: outsideWorkspaceFrame,
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_AUTHORIZED" });
    await adapter.shutdown();
  });

  it("shares active-turn capacity across Codex tasks", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const manager = createTaskManager(connection);
    writeTaskCapacitySettings(new SettingsRepository(connection.database), {
      concurrentTaskCapacity: 1,
    });
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const first = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000021",
      workspace,
      workspaceRiskAccepted: true,
    });
    const second = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000022",
      workspace,
      workspaceRiskAccepted: true,
    });

    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "first-turn",
        method: "turn/start",
        params: { input: [] },
      }),
      taskId: first.task.id,
    });
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "duplicate-first-turn",
          method: "turn/start",
          params: { input: [] },
        }),
        taskId: first.task.id,
      }),
    ).rejects.toMatchObject({ code: "TASK_BUSY" });
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "second-turn",
          method: "turn/start",
          params: { input: [] },
        }),
        taskId: second.task.id,
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_TASK_LIMIT_REACHED" });
    expect(manager.getTask(first.task.id).state).toBe("executing");
    expect(manager.getTask(second.task.id).state).toBe("idle");
    expect(
      process.writes.filter((frame) => frame.method === "turn/start"),
    ).toHaveLength(1);

    await manager.shutdown();
    await adapter.shutdown();
  });

  it("keeps catalog reads outside a blocked P2 task lane", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const manager = createTaskManager(connection);
    const baseRuntime = manager.providerTaskRuntime();
    let markRunEntered = (): void => {};
    let releaseRun = (): void => {};
    const runEntered = new Promise<void>((resolve) => {
      markRunEntered = resolve;
    });
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const taskRuntime: ProviderTaskRuntime = {
      ...baseRuntime,
      run: async (taskId, operation) => {
        markRunEntered();
        await runGate;
        return baseRuntime.run(taskId, operation);
      },
    };
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime,
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000023",
      workspace,
      workspaceRiskAccepted: true,
    });
    const blockedTurn = adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "blocked-turn",
        method: "turn/start",
        params: { input: [] },
      }),
      taskId: requireTaskResult(created).id,
    });
    await runEntered;

    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "models",
          method: "model/list",
          params: {},
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).resolves.toMatchObject({ id: requireTaskResult(created).id });
    expect(process.writes).toContainEqual(
      expect.objectContaining({ method: "model/list" }),
    );

    releaseRun();
    await blockedTurn;
    await manager.shutdown();
    await adapter.shutdown();
  });

  it("invalidates active and queued P2 frames before a native interrupt", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const manager = createTaskManager(connection);
    let blockPaths = false;
    let markPathEntered = (): void => {};
    let releasePath = (): void => {};
    const pathEntered = new Promise<void>((resolve) => {
      markPathEntered = resolve;
    });
    const pathGate = new Promise<void>((resolve) => {
      releasePath = resolve;
    });
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => {
          if (blockPaths && path.endsWith("\\pending")) {
            markPathEntered();
            await pathGate;
          }
          return path;
        },
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000024",
      workspace,
      workspaceRiskAccepted: true,
    });
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "active-turn",
        method: "turn/start",
        params: { input: [] },
      }),
      taskId: requireTaskResult(created).id,
    });

    blockPaths = true;
    const steer = (id: string) =>
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id,
          method: "turn/steer",
          params: {
            cwd: `${workspace}\\pending`,
            expectedTurnId: "turn-1",
            input: [],
          },
        }),
        taskId: requireTaskResult(created).id,
      });
    const activeSteer = steer("active-steer");
    await pathEntered;
    const queuedSteer = steer("queued-steer");
    const activeResult = expect(activeSteer).rejects.toMatchObject({
      code: "TASK_OPERATION_SUPERSEDED",
    });
    const queuedResult = expect(queuedSteer).rejects.toMatchObject({
      code: "TASK_OPERATION_SUPERSEDED",
    });

    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "interrupt",
          method: "turn/interrupt",
          params: { turnId: "turn-1" },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).resolves.toMatchObject({ state: "idle" });
    releasePath();
    await Promise.all([activeResult, queuedResult]);
    expect(
      process.writes.filter((frame) => frame.method === "turn/steer"),
    ).toHaveLength(0);

    await manager.shutdown();
    await adapter.shutdown();
  });

  it("rolls back a reserved turn when App Server rejects turn/start", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const manager = createTaskManager(connection);
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000025",
      workspace,
      workspaceRiskAccepted: true,
    });
    process.failTurnStarts = true;

    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "rejected-turn",
          method: "turn/start",
          params: { input: [] },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).resolves.toMatchObject({ state: "idle" });
    expect(manager.getTask(requireTaskResult(created).id)).toMatchObject({
      activeTurnId: null,
      state: "idle",
    });
    process.emitFrame({
      method: "serverRequest/resolved",
      params: { requestId: "unknown", threadId: "thread-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(requireTaskResult(created).id).state).toBe("idle");

    await manager.shutdown();
    await adapter.shutdown();
  });

  it("completes native interrupt cleanup even without turn/completed", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const manager = createTaskManager(connection);
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000026",
      workspace,
      workspaceRiskAccepted: true,
    });
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "turn-before-failed-interrupt",
        method: "turn/start",
        params: { input: [] },
      }),
      taskId: requireTaskResult(created).id,
    });
    process.failInterrupts = true;

    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "failed-interrupt",
          method: "turn/interrupt",
          params: { turnId: "turn-1" },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).resolves.toMatchObject({ state: "idle" });
    expect(manager.getTask(requireTaskResult(created).id)).toMatchObject({
      activeTurnId: null,
      state: "idle",
    });

    await manager.shutdown();
    await adapter.shutdown();
  });

  it("prevents a close from being overtaken by a stale turn frame", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const manager = createTaskManager(connection);
    let blockPaths = false;
    let markPathEntered = (): void => {};
    let releasePath = (): void => {};
    const pathEntered = new Promise<void>((resolve) => {
      markPathEntered = resolve;
    });
    const pathGate = new Promise<void>((resolve) => {
      releasePath = resolve;
    });
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => {
          if (blockPaths && path.endsWith("\\pending")) {
            markPathEntered();
            await pathGate;
          }
          return path;
        },
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000027",
      workspace,
      workspaceRiskAccepted: true,
    });
    blockPaths = true;
    const staleTurn = adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "stale-turn",
        method: "turn/start",
        params: { cwd: `${workspace}\\pending`, input: [] },
      }),
      taskId: requireTaskResult(created).id,
    });
    const staleResult = expect(staleTurn).rejects.toMatchObject({
      code: "TASK_OPERATION_SUPERSEDED",
    });
    await pathEntered;

    await manager.closeTask({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000028",
      taskId: requireTaskResult(created).id,
    });
    releasePath();
    await staleResult;
    expect(
      process.writes.filter((frame) => frame.method === "turn/start"),
    ).toHaveLength(0);

    await manager.shutdown();
    await adapter.shutdown();
  });

  it("advertises Codex native action capabilities without attachment support", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: createTaskRuntime(connection),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });

    expect(adapter.descriptor.capabilities).toEqual({
      activeTurnSteering: true,
      approvals: true,
      attachments: false,
      effort: true,
      historyPagination: "cursor",
      interrupt: true,
      modes: true,
      models: true,
      nativeActions: {
        compact: {
          availability: "idle",
          method: "thread/compact/start",
          startsTurn: true,
        },
        rename: {
          availability: "always",
          method: "thread/name/set",
          startsTurn: false,
        },
        review: {
          availability: "idle",
          deliveries: ["inline"],
          method: "review/start",
          startsTurn: true,
          targetTypes: ["uncommittedChanges", "baseBranch", "commit", "custom"],
        },
      },
      newConversation: true,
      resumeConversation: true,
      statusCatalogs: {
        account: true,
        hooks: true,
        mcpServers: true,
        rateLimits: true,
        skills: true,
      },
      streamProtocol: "codex-app-server-json-rpc",
      threadManagement: {
        archive: true,
        delete: true,
        fork: true,
        includeArchived: true,
        search: true,
        unarchive: true,
      },
    });
    await adapter.shutdown();
  });

  it("forwards readonly status catalogs as P3 reads and projects path-safe payloads", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const manager = createTaskManager(connection);
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000041",
      workspace,
      workspaceRiskAccepted: true,
    });
    const received: unknown[] = [];
    adapter.taskStream.subscribe(requireTaskResult(created).id, undefined, {
      send(frame) {
        received.push(frame);
      },
    });
    await adapter.taskStream.activate(requireTaskResult(created).id);

    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "account-1",
        method: "account/read",
        params: {},
      }),
      taskId: requireTaskResult(created).id,
    });
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "skills-1",
        method: "skills/list",
        params: { cwd: workspace },
      }),
      taskId: requireTaskResult(created).id,
    });
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "hooks-1",
        method: "hooks/list",
        params: {},
      }),
      taskId: requireTaskResult(created).id,
    });
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "mcp-1",
        method: "mcpServerStatus/list",
        params: {},
      }),
      taskId: requireTaskResult(created).id,
    });
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "limits-1",
        method: "account/rateLimits/read",
        params: {},
      }),
      taskId: requireTaskResult(created).id,
    });

    expect(process.writes).toContainEqual(
      expect.objectContaining({
        method: "account/read",
        params: {},
      }),
    );
    expect(process.writes).toContainEqual(
      expect.objectContaining({
        method: "skills/list",
        params: { cwds: [workspace] },
      }),
    );
    expect(process.writes).toContainEqual(
      expect.objectContaining({
        method: "hooks/list",
        params: { cwds: [workspace] },
      }),
    );
    expect(process.writes).toContainEqual(
      expect.objectContaining({
        method: "mcpServerStatus/list",
        params: {},
      }),
    );
    expect(process.writes).toContainEqual(
      expect.objectContaining({
        method: "account/rateLimits/read",
        params: {},
      }),
    );

    await waitFor(() =>
      received.some(
        (frame) =>
          isObject(frame) && frame.id === "account-1" && isObject(frame.result),
      ),
    );

    expect(received).toContainEqual({
      id: "account-1",
      result: {
        account: {
          planType: "pro",
          type: "chatgpt",
        },
        requiresOpenaiAuth: true,
      },
    });
    expect(JSON.stringify(received)).not.toContain("user@example.com");
    expect(received).toContainEqual({
      id: "skills-1",
      result: {
        data: [
          {
            description: "Review helper",
            enabled: true,
            metadata: {
              description: "Review helper",
              name: "review",
            },
            name: "review",
            scope: "repo",
          },
        ],
        errors: [
          {
            message: "bad skill",
            scope: "user",
          },
        ],
      },
    });
    expect(received).toContainEqual({
      id: "hooks-1",
      result: {
        data: [
          {
            description: "pre tool",
            enabled: true,
            hooks: ["PreToolUse"],
            metadata: {
              hooks: ["PreToolUse"],
              name: "guard",
            },
            name: "guard",
            scope: "user",
          },
        ],
      },
    });
    expect(received).toContainEqual({
      id: "mcp-1",
      result: {
        data: [
          {
            authStatus: "unsupported",
            name: "demo",
            tools: [
              {
                description: "demo tool",
                name: "echo",
              },
            ],
          },
        ],
      },
    });
    expect(received).toContainEqual({
      id: "limits-1",
      result: {
        rateLimits: {
          limit_id: "primary",
          plan_type: "pro",
          primary: { used_percent: 12 },
        },
      },
    });
    expect(JSON.stringify(received)).not.toContain("secret-token");
    expect(JSON.stringify(received)).not.toContain("quota-secret");
    expect(JSON.stringify(received)).not.toContain("C:\\skills");
    expect(JSON.stringify(received)).not.toContain("C:\\hooks");
    expect(JSON.stringify(received)).not.toContain('"command"');

    process.emitFrame({
      method: "account/updated",
      params: {
        authMode: "chatgpt",
        planType: "pro",
      },
    });
    process.emitFrame({
      method: "skills/changed",
      params: {
        cwd: "C:\\skills",
      },
    });
    process.emitFrame({
      method: "hook/started",
      params: {
        run: {
          eventName: "PreToolUse",
          id: "run-1",
          sourcePath: "C:\\hooks\\guard",
          status: "running",
        },
        threadId: "thread-1",
      },
    });
    process.emitFrame({
      method: "mcpServer/startupStatus/updated",
      params: {
        command: "npx",
        name: "demo",
        status: "ready",
      },
    });

    await waitFor(() =>
      received.some(
        (frame) =>
          isObject(frame) && frame.method === "mcpServer/startupStatus/updated",
      ),
    );

    expect(received).toContainEqual({
      method: "account/updated",
      params: {
        authMode: "chatgpt",
        planType: "pro",
      },
    });
    expect(received).toContainEqual({
      method: "skills/changed",
      params: {},
    });
    expect(received).toContainEqual({
      method: "hook/started",
      params: {
        run: {
          eventName: "PreToolUse",
          id: "run-1",
          status: "running",
        },
        threadId: "thread-1",
      },
    });
    expect(received).toContainEqual({
      method: "mcpServer/startupStatus/updated",
      params: {
        name: "demo",
        status: "ready",
      },
    });

    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "refresh-forbidden",
          method: "account/read",
          params: { refreshToken: true },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "CODEX_REQUEST_NOT_ALLOWED" });
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "skills-escape",
          method: "skills/list",
          params: { cwds: ["C:\\outside"] },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_AUTHORIZED" });
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "skills-cwd-escape",
          method: "skills/list",
          params: { cwd: "C:\\outside" },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_AUTHORIZED" });

    await adapter.shutdown();
  });

  it("forwards native review, rename, and compact actions with shared lifecycle rules", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const manager = createTaskManager(connection);
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000031",
      workspace,
      workspaceRiskAccepted: true,
    });
    const received: unknown[] = [];
    adapter.taskStream.subscribe(requireTaskResult(created).id, undefined, {
      send(frame) {
        received.push(frame);
      },
    });
    await adapter.taskStream.activate(requireTaskResult(created).id);

    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "rename-1",
        method: "thread/name/set",
        params: { name: "Provider parity audit" },
      }),
      taskId: requireTaskResult(created).id,
    });
    expect(process.writes).toContainEqual(
      expect.objectContaining({
        method: "thread/name/set",
        params: {
          name: "Provider parity audit",
          threadId: "thread-1",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toContainEqual({
      method: "thread/name/updated",
      params: { name: "Provider parity audit", threadId: "thread-1" },
    });
    expect(manager.getTask(requireTaskResult(created).id).state).toBe("idle");

    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "review-1",
        method: "review/start",
        params: {
          delivery: "inline",
          target: { type: "uncommittedChanges" },
        },
      }),
      taskId: requireTaskResult(created).id,
    });
    expect(process.writes).toContainEqual(
      expect.objectContaining({
        method: "review/start",
        params: {
          delivery: "inline",
          target: { type: "uncommittedChanges" },
          threadId: "thread-1",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(requireTaskResult(created).id)).toMatchObject({
      activeTurnId: "review-turn-1",
      state: "executing",
    });
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "steer-during-review",
          method: "turn/steer",
          params: {
            expectedTurnId: "review-turn-1",
            input: [{ text: "nudge", text_elements: [], type: "text" }],
          },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "TASK_BUSY" });
    process.emitFrame({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "review-turn-1", status: "completed" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(requireTaskResult(created).id)).toMatchObject({
      activeTurnId: null,
      state: "idle",
    });

    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "compact-1",
        method: "thread/compact/start",
        params: {},
      }),
      taskId: requireTaskResult(created).id,
    });
    expect(process.writes).toContainEqual(
      expect.objectContaining({
        method: "thread/compact/start",
        params: { threadId: "thread-1" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(requireTaskResult(created).id)).toMatchObject({
      activeTurnId: "compact-turn-1",
      state: "executing",
    });
    process.emitFrame({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-1", status: "completed" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await manager.shutdown();
    await adapter.shutdown();
  });

  it("rejects detached review, unsupported targets, and empty rename names", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    const manager = createTaskManager(connection);
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000032",
      workspace,
      workspaceRiskAccepted: true,
    });
    await adapter.taskStream.activate(requireTaskResult(created).id);

    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "detached-review",
          method: "review/start",
          params: {
            delivery: "detached",
            target: { type: "uncommittedChanges" },
          },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "CODEX_REQUEST_NOT_ALLOWED" });
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "bad-target",
          method: "review/start",
          params: {
            delivery: "inline",
            target: { type: "unsupported" },
          },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "CODEX_REQUEST_NOT_ALLOWED" });
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "empty-name",
          method: "thread/name/set",
          params: { name: "   " },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "CODEX_REQUEST_NOT_ALLOWED" });
    expect(
      process.writes.filter(
        (frame) =>
          frame.method === "review/start" || frame.method === "thread/name/set",
      ),
    ).toHaveLength(0);

    await manager.shutdown();
    await adapter.shutdown();
  });

  it("rolls back shared capacity when a native review start fails", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    process.failTurnStarts = true;
    const manager = createTaskManager(connection);
    writeTaskCapacitySettings(new SettingsRepository(connection.database), {
      concurrentTaskCapacity: 1,
    });
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const first = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000033",
      workspace,
      workspaceRiskAccepted: true,
    });
    const second = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000034",
      workspace,
      workspaceRiskAccepted: true,
    });
    await adapter.taskStream.activate(first.task.id);

    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "failed-review",
        method: "review/start",
        params: {
          delivery: "inline",
          target: { type: "uncommittedChanges" },
        },
      }),
      taskId: first.task.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(first.task.id).state).toBe("idle");
    expect(manager.getTask(first.task.id).activeTurnId).toBeNull();

    // Capacity must be free for another task after rollback.
    process.failTurnStarts = false;
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "second-turn",
        method: "turn/start",
        params: { input: [] },
      }),
      taskId: second.task.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(second.task.id).state).toBe("executing");

    await manager.shutdown();
    await adapter.shutdown();
  });

  it("keeps an authoritative review turn when the native request later errors", async () => {
    const connection = openStorage({ databasePath: ":memory:" });
    connections.push(connection);
    insertDevice(connection);
    const process = new FakeCodexProcess();
    process.errorAfterTurnStarted = true;
    const manager = createTaskManager(connection);
    writeTaskCapacitySettings(new SettingsRepository(connection.database), {
      concurrentTaskCapacity: 1,
    });
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
      taskRuntime: manager.providerTaskRuntime(),
      workspaceDirectoryResolver: {
        canonicalizeDirectory: async (path) => path,
      },
    });
    manager.setProviderTaskController(adapter.taskLifecycle);
    const created = await adapter.createConversation({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000035",
      workspace,
      workspaceRiskAccepted: true,
    });
    await adapter.taskStream.activate(requireTaskResult(created).id);

    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "late-error-review",
        method: "review/start",
        params: {
          delivery: "inline",
          target: { type: "uncommittedChanges" },
        },
      }),
      taskId: requireTaskResult(created).id,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(requireTaskResult(created).id).state).toBe(
      "executing",
    );
    expect(manager.getTask(requireTaskResult(created).id).activeTurnId).toBe(
      "review-turn-1",
    );

    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: parseClientFrame(adapter, {
          id: "steer-after-late-error",
          method: "turn/steer",
          params: {
            input: [{ text: "should stay blocked", type: "text" }],
            turnId: "review-turn-1",
          },
        }),
        taskId: requireTaskResult(created).id,
      }),
    ).rejects.toMatchObject({ code: "TASK_BUSY" });
    expect(process.writes.some((frame) => frame.method === "turn/steer")).toBe(
      false,
    );

    await manager.shutdown();
    await adapter.shutdown();
  });
});

function thread(
  id = "thread-1",
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cwd: workspace,
    id,
    sessionId: `session-${id.slice("thread-".length)}`,
    turns: [],
    ...extras,
  };
}

function insertDevice(connection: StorageConnection): void {
  connection.sqlite
    .prepare(
      "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(deviceId, "test", "public", 1);
}

function parseClientFrame(
  adapter: CodexProviderAdapter,
  frame: Record<string, unknown>,
): unknown {
  const parsed = adapter.taskStream.parseClientFrame(
    JSON.stringify(frame),
    false,
  );
  if (parsed === undefined) {
    throw new Error("The test Codex frame is invalid.");
  }
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("Timed out waiting for Codex adapter condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createTaskManager(
  connection: StorageConnection,
  eventSink?: TaskEventJournal,
): TaskManager {
  const settingsRepository = new SettingsRepository(connection.database);
  writeTaskRuntimeSettings(settingsRepository, {
    concurrentTaskCapacity: 3,
    workspaceRoots: [workspace],
  });
  return new TaskManager({
    directoryResolver: {
      canonicalizeDirectory: async (path) => path,
    },
    ...(eventSink === undefined ? {} : { eventSink }),
    pathResolver: {
      canonicalize: async (path) => path,
    },
    settingsRepository,
    sqlite: connection.database,
  });
}

function createTaskRuntime(connection: StorageConnection) {
  return createTaskManager(connection).providerTaskRuntime();
}
