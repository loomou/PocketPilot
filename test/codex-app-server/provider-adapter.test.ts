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
  public failInterrupts = false;
  public failTurnStarts = false;
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
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
      if (frame.method === "turn/start") {
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
        this.emitFrame({ id: frame.id, result: { turn: { id: "turn-1" } } });
        this.emitFrame({
          method: "turn/started",
          params: { threadId, turn: { id: "turn-1" } },
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
    expect(created.task.provider).toBe("codex");
    expect(created.task.nativeConversationId).toBe("thread-1");
    expect(created.task.nativeSessionId).toBe("session-1");

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
    expect(attached.task.id).toBe(created.task.id);
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
    eventJournal.subscribeControl(created.task.id, -1, {
      send(event) {
        controlEvents.push(event);
      },
    });
    const unsubscribe = adapter.taskStream.subscribe(
      created.task.id,
      undefined,
      {
        send(frame) {
          received.push(frame);
        },
      },
    );
    await adapter.taskStream.activate(created.task.id);
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
      taskId: created.task.id,
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
    expect(taskManager.getTask(created.task.id).state).toBe(
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
        taskId: created.task.id,
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
        taskId: created.task.id,
      }),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
    await adapter.taskStream.submit({
      deviceId,
      message: response,
      taskId: created.task.id,
    });
    expect(process.writes).toContainEqual({
      id: "approval-1",
      result: { decision: "accept" },
    });
    expect(taskManager.getTask(created.task.id).state).toBe(
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
      taskId: created.task.id,
    });
    expect(process.writes).toContainEqual({
      id: "approval-2",
      result: { decision: "decline" },
    });
    expect(taskManager.getTask(created.task.id).state).toBe("executing");
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
    await adapter.taskStream.activate(created.task.id);

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
      taskId: created.task.id,
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
        taskId: created.task.id,
      }),
    ).rejects.toMatchObject({ code: "TASK_BUSY" });
    expect(second.writes.map((frame) => frame.method)).toContain(
      "thread/resume",
    );
    expect(second.writes.map((frame) => frame.method)).not.toContain(
      "turn/interrupt",
    );
    expect(manager.getTask(created.task.id).state).toBe("idle");

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
    await adapter.taskStream.activate(created.task.id);
    await adapter.taskStream.submit({
      deviceId,
      message: parseClientFrame(adapter, {
        id: "turn-before-reconnect",
        method: "turn/start",
        params: { input: [] },
      }),
      taskId: created.task.id,
    });
    first.emitFrame({
      id: "approval-old",
      method: "item/commandExecution/requestApproval",
      params: { command: "git status", threadId: "thread-1", turnId: "turn-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    first.emit("close", 1, null);
    await adapter.taskStream.activate(created.task.id);

    const staleResponse = adapter.taskStream.parseClientFrame(
      JSON.stringify({ id: "approval-old", result: { decision: "accept" } }),
      false,
    );
    await expect(
      adapter.taskStream.submit({
        deviceId,
        message: staleResponse,
        taskId: created.task.id,
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
        taskId: created.task.id,
      }),
    ).resolves.toMatchObject({ id: created.task.id });

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
        taskId: created.task.id,
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
      taskId: created.task.id,
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
        taskId: created.task.id,
      }),
    ).resolves.toMatchObject({ id: created.task.id });
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
      taskId: created.task.id,
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
        taskId: created.task.id,
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
        taskId: created.task.id,
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
        taskId: created.task.id,
      }),
    ).resolves.toMatchObject({ state: "idle" });
    expect(manager.getTask(created.task.id)).toMatchObject({
      activeTurnId: null,
      state: "idle",
    });
    process.emitFrame({
      method: "serverRequest/resolved",
      params: { requestId: "unknown", threadId: "thread-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(created.task.id).state).toBe("idle");

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
      taskId: created.task.id,
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
        taskId: created.task.id,
      }),
    ).resolves.toMatchObject({ state: "idle" });
    expect(manager.getTask(created.task.id)).toMatchObject({
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
      taskId: created.task.id,
    });
    const staleResult = expect(staleTurn).rejects.toMatchObject({
      code: "TASK_OPERATION_SUPERSEDED",
    });
    await pathEntered;

    await manager.closeTask({
      deviceId,
      operationId: "00000000-0000-4000-8000-000000000028",
      taskId: created.task.id,
    });
    releasePath();
    await staleResult;
    expect(
      process.writes.filter((frame) => frame.method === "turn/start"),
    ).toHaveLength(0);

    await manager.shutdown();
    await adapter.shutdown();
  });
});

function thread(id = "thread-1"): Record<string, unknown> {
  return {
    cwd: workspace,
    id,
    sessionId: `session-${id.slice("thread-".length)}`,
    turns: [],
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
