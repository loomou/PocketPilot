import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerBridge } from "../../src/codex-app-server/bridge.js";
import { CodexProviderAdapter } from "../../src/codex-app-server/provider-adapter.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { TaskRepository } from "../../src/tasks/task-repository.js";

class FakeCodexProcess extends EventEmitter {
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly writes: Record<string, unknown>[] = [];

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
        this.emitFrame({ id: frame.id, result: { thread: thread() } });
      }
      if (frame.method === "thread/read" || frame.method === "thread/resume") {
        this.emitFrame({ id: frame.id, result: { thread: thread() } });
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
      if (
        frame.method === "thread/unsubscribe" ||
        frame.method === "turn/interrupt"
      ) {
        this.emitFrame({ id: frame.id, result: {} });
      }
      if (frame.method === "turn/start") {
        this.emitFrame({ id: frame.id, result: { turn: { id: "turn-1" } } });
        this.emitFrame({
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "turn-1" } },
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
    const adapter = new CodexProviderAdapter({
      bridge: new CodexAppServerBridge({
        processFactory: () => process,
        requestTimeoutMs: 1_000,
      }),
      repository: new TaskRepository(connection.database),
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

    const response = adapter.taskStream.parseClientFrame(
      JSON.stringify({ id: "approval-1", result: { decision: "accept" } }),
      false,
    );
    expect(response).toBeDefined();
    await adapter.taskStream.submit({
      deviceId,
      message: response,
      taskId: created.task.id,
    });
    expect(process.writes).toContainEqual({
      id: "approval-1",
      result: { decision: "accept" },
    });
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
});

function thread(): Record<string, unknown> {
  return {
    cwd: workspace,
    id: "thread-1",
    sessionId: "session-1",
    turns: [],
  };
}
