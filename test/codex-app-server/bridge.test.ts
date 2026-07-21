import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  CodexAppServerBridge,
  isCodexCommandAvailable,
  probeCodexReadiness,
} from "../../src/codex-app-server/bridge.js";

class FakeCodexProcess extends EventEmitter {
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly writes: Record<string, unknown>[] = [];
  public pid = 9001;
  public killCalls = 0;

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
      if (frame.method === "turn/start") {
        this.emitFrame({ id: frame.id, result: { accepted: true } });
      }
    });
  }

  public kill(): boolean {
    this.killCalls += 1;
    this.emit("close", 0, null);
    return true;
  }

  public emitFrame(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}

class DelayedCloseCodexProcess extends FakeCodexProcess {
  public override kill(): boolean {
    this.killCalls += 1;
    return true;
  }
}

describe("CodexAppServerBridge", () => {
  it("detects configured commands without starting them", () => {
    expect(isCodexCommandAvailable(process.execPath)).toBe(true);
    expect(
      isCodexCommandAvailable("pocketpilot-command-that-does-not-exist"),
    ).toBe(false);
  });

  it("initializes once and forwards native request responses to the owning task", async () => {
    const process = new FakeCodexProcess();
    const deliveries: Array<{
      frame: Record<string, unknown>;
      taskId?: string;
    }> = [];
    const bridge = new CodexAppServerBridge({
      processFactory: () => process,
      requestTimeoutMs: 1_000,
    });
    bridge.subscribe((delivery) => deliveries.push(delivery));

    await expect(bridge.start()).resolves.toMatchObject({
      cliVersion: "0.144.6",
    });
    await bridge.forward("task-1", {
      id: "mobile-1",
      method: "turn/start",
      params: { input: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliveries).toContainEqual({
      frame: { id: "mobile-1", result: { accepted: true } },
      taskId: "task-1",
    });
    const initializeWrites = process.writes.filter(
      (frame) => frame.method === "initialize",
    );
    expect(initializeWrites).toHaveLength(1);
    const initializeParams = initializeWrites[0]?.params as
      | {
          clientInfo?: { name?: string; title?: string };
        }
      | undefined;
    expect(initializeParams?.clientInfo?.name).toBe("codex_cli_rs");
    expect(initializeParams?.clientInfo?.title).toBe("PocketPilot");
    expect(
      process.writes.find((frame) => frame.method === "turn/start")?.id,
    ).not.toBe("mobile-1");
    await bridge.close();
    expect(process.killCalls).toBe(1);
  });

  it("isolates identical client request ids across tasks", async () => {
    const process = new FakeCodexProcess();
    const deliveries: Array<{
      frame: Record<string, unknown>;
      taskId?: string;
    }> = [];
    const bridge = new CodexAppServerBridge({ processFactory: () => process });
    bridge.subscribe((delivery) => deliveries.push(delivery));
    await bridge.start();

    await Promise.all([
      bridge.forward("task-1", {
        id: 1,
        method: "thread/read",
        params: { threadId: "thread-1" },
      }),
      bridge.forward("task-2", {
        id: 1,
        method: "thread/read",
        params: { threadId: "thread-2" },
      }),
    ]);
    const forwarded = process.writes.filter(
      (frame) => frame.method === "thread/read",
    );
    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]?.id).not.toBe(forwarded[1]?.id);

    for (const frame of forwarded) {
      process.emitFrame({ id: frame.id, result: { accepted: true } });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliveries).toContainEqual({
      frame: { id: 1, result: { accepted: true } },
      taskId: "task-1",
    });
    expect(deliveries).toContainEqual({
      frame: { id: 1, result: { accepted: true } },
      taskId: "task-2",
    });
    await bridge.close();
  });

  it("rejects pending requests and terminates the process after native exit", async () => {
    const process = new FakeCodexProcess();
    const bridge = new CodexAppServerBridge({
      processFactory: () => process,
      requestTimeoutMs: 1_000,
    });
    await bridge.start();
    const pending = bridge.request("thread/read", { threadId: "thread-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.emit("close", 1, null);

    await expect(pending).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_EXITED",
    });
    expect(process.killCalls).toBe(1);
    await bridge.close();
  });

  it("ignores late events from an old process after reconnect", async () => {
    const processes: FakeCodexProcess[] = [];
    const bridge = new CodexAppServerBridge({
      processFactory: () => {
        const process = new DelayedCloseCodexProcess();
        processes.push(process);
        return process;
      },
      requestTimeoutMs: 1_000,
    });

    await bridge.start();
    const first = processes[0];
    if (first === undefined) {
      throw new Error("The first fake process was not created.");
    }
    first.emit("close", 1, null);
    await bridge.start();
    const second = processes[1];
    if (second === undefined) {
      throw new Error("The replacement fake process was not created.");
    }

    first.emit("close", 1, null);
    await expect(
      bridge.request("thread/read", { threadId: "thread-1" }),
    ).rejects.toMatchObject({ code: "CODEX_APP_SERVER_REQUEST_TIMEOUT" });
    expect(second.killCalls).toBe(0);
    await bridge.close();
  });

  it("rejects malformed native output and pending requests", async () => {
    const process = new FakeCodexProcess();
    const bridge = new CodexAppServerBridge({
      processFactory: () => process,
      requestTimeoutMs: 1_000,
    });
    await bridge.start();
    const pending = bridge.request("thread/read", { threadId: "thread-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.stdout.write("not-json\n");
    await expect(pending).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_FRAME_INVALID",
    });
    await bridge.close();
  });

  it("delivers server requests without translating their native method or params", async () => {
    const process = new FakeCodexProcess();
    const deliveries: Array<{
      frame: Record<string, unknown>;
      taskId?: string;
    }> = [];
    const bridge = new CodexAppServerBridge({ processFactory: () => process });
    bridge.subscribe((delivery) => deliveries.push(delivery));
    await bridge.start();

    process.emitFrame({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "git status", threadId: "thread-1", turnId: "turn-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliveries).toContainEqual({
      frame: {
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          command: "git status",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
    });
    await bridge.close();
  });

  it("maps readiness probe outcomes without leaking install paths", async () => {
    await expect(
      probeCodexReadiness({
        command: "pocketpilot-command-that-does-not-exist",
      }),
    ).resolves.toEqual({
      reasonCode: "CODEX_COMMAND_NOT_FOUND",
      status: "not_installed",
    });

    const missingPath =
      "C:\\Users\\secret\\AppData\\Local\\Programs\\codex.exe";
    const missing = await probeCodexReadiness({ command: missingPath });
    expect(missing).toEqual({
      reasonCode: "CODEX_COMMAND_NOT_FOUND",
      status: "not_installed",
    });
    expect(JSON.stringify(missing)).not.toContain("Users\\secret");

    const healthyBridge = {
      initializeInfo: {
        cliVersion: "0.144.6",
        platformFamily: "windows",
        platformOs: "windows",
        userAgent: "codex-app-server",
      },
    } as CodexAppServerBridge;
    await expect(
      probeCodexReadiness({
        command: process.execPath,
        existingBridge: healthyBridge,
      }),
    ).resolves.toEqual({
      protocolVersion: expect.stringContaining("codex-app-server@"),
      status: "available",
    });

    const unsupportedBridge = {
      initializeInfo: {
        cliVersion: "0.143.0",
        platformFamily: "windows",
        platformOs: "windows",
        userAgent: "codex-app-server",
      },
    } as CodexAppServerBridge;
    await expect(
      probeCodexReadiness({
        command: process.execPath,
        existingBridge: unsupportedBridge,
      }),
    ).resolves.toEqual({
      reasonCode: "CODEX_APP_SERVER_VERSION_UNSUPPORTED",
      status: "unsupported_version",
    });

    // createBridge is a DI seam for unit tests. The probe always closes the
    // bridge it starts so timeouts cannot leave an App Server child running.
    const child = new FakeCodexProcess();
    const createdBridge = new CodexAppServerBridge({
      processFactory: () => child,
      requestTimeoutMs: 1_000,
    });
    let closed = false;
    const originalClose = createdBridge.close.bind(createdBridge);
    createdBridge.close = async () => {
      closed = true;
      await originalClose();
    };
    await expect(
      probeCodexReadiness({
        command: process.execPath,
        createBridge: () => createdBridge,
      }),
    ).resolves.toEqual({
      protocolVersion: expect.stringContaining("codex-app-server@"),
      status: "available",
    });
    expect(child.writes.some((frame) => frame.method === "initialize")).toBe(
      true,
    );
    expect(closed).toBe(true);
  });
});
