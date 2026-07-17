import { randomUUID } from "node:crypto";

import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryDeviceConnectionRegistry } from "../../src/auth/device-connection-registry.js";
import { createHttpApp } from "../../src/http/create-http-app.js";
import { InMemoryTaskSdkConnectionRegistry } from "../../src/remote-api/task-sdk-connection-registry.js";
import {
  parseSdkUserMessageFrame,
  registerTaskSdkRoutes,
  sdkWebSocketClose,
} from "../../src/remote-api/task-sdk-routes.js";
import { TaskError } from "../../src/tasks/errors.js";
import type { TaskSdkMessageSubscriber } from "../../src/tasks/task-events.js";
import type { TaskSnapshot } from "../../src/tasks/task-types.js";

const deviceId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";

describe("task SDK WebSocket", () => {
  const apps: Array<Awaited<ReturnType<typeof createHttpApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("passes raw SDK messages in both directions and forwards afterUuid", async () => {
    const fixture = await createFixture(apps);
    const client = await fixture.app.injectWS(
      `/v1/tasks/${taskId}/sdk?afterUuid=message-anchor`,
      { headers: { authorization: "Bearer access-token" } },
    );

    expect(fixture.journal.afterUuid).toBe("message-anchor");
    expect(fixture.journal.taskId).toBe(taskId);
    await waitFor(() => fixture.activationObservedSubscriber.length === 1);
    expect(fixture.activationObservedSubscriber).toEqual([true]);

    const output = {
      type: "future_sdk_variant",
      uuid: randomUUID(),
      session_id: "sdk-session",
      nested_extension: { preserved: true },
    } as unknown as SDKMessage;
    const outputReceived = nextMessage(client);
    fixture.journal.subscriber?.send(output);
    await expect(outputReceived).resolves.toEqual(output);

    const input = {
      type: "user",
      message: { role: "user", content: "raw input" },
      parent_tool_use_id: null,
      priority: "now",
      shouldQuery: false,
      unknown_sdk_extension: { preserved: true },
    } as unknown as SDKUserMessage;
    client.send(JSON.stringify(input));
    await waitFor(() => fixture.submissions.length === 1);

    expect(fixture.submissions[0]).toEqual(input);
    expect(fixture.submissions[0]).not.toHaveProperty("operationId");
    expect(fixture.submissions[0]).not.toHaveProperty("payload");
    client.terminate();
  });

  it("delivers the original system init after subscribing and before input", async () => {
    const init = {
      apiKeySource: "none",
      cwd: "C:\\workspace",
      model: "opus",
      permissionMode: "default",
      session_id: "sdk-session",
      subtype: "init",
      tools: [],
      type: "system",
      uuid: randomUUID(),
    } as unknown as SDKMessage;
    const fixture = await createFixture(apps, { activationMessage: init });
    const client = await fixture.app.injectWS(`/v1/tasks/${taskId}/sdk`, {
      headers: { authorization: "Bearer access-token" },
    });

    await expect(nextMessage(client)).resolves.toEqual(init);
    expect(fixture.activationObservedSubscriber).toEqual([true]);
    client.terminate();
  });

  it("closes invalid SDK input without submitting it", async () => {
    const fixture = await createFixture(apps);
    const client = await fixture.app.injectWS(`/v1/tasks/${taskId}/sdk`, {
      headers: { authorization: "Bearer access-token" },
    });
    const closed = nextClose(client);

    client.send(JSON.stringify({ type: "event", payload: {} }));

    await expect(closed).resolves.toEqual(sdkWebSocketClose.messageInvalid);
    expect(fixture.submissions).toEqual([]);
  });

  it("guards the SDK base contract without requiring optional identifiers", () => {
    const valid = {
      type: "user",
      message: { role: "user", content: [{ text: "hello", type: "text" }] },
      parent_tool_use_id: null,
      shouldQuery: false,
      unknown_sdk_extension: { preserved: true },
    };

    expect(
      parseSdkUserMessageFrame(Buffer.from(JSON.stringify(valid))),
    ).toEqual(valid);
    expect(
      parseSdkUserMessageFrame(
        Buffer.from(JSON.stringify({ ...valid, priority: "invalid" })),
      ),
    ).toBeUndefined();
    expect(
      parseSdkUserMessageFrame(
        Buffer.from(
          JSON.stringify({ ...valid, message: { content: 42, role: "user" } }),
        ),
      ),
    ).toBeUndefined();
    expect(
      parseSdkUserMessageFrame(Buffer.from(JSON.stringify(valid)), true),
    ).toBeUndefined();
  });

  it("uses stable close codes for authentication, missing tasks, and revocation", async () => {
    const unauthorizedFixture = await createFixture(apps, {
      authenticate: false,
    });
    let unauthorizedClose:
      | Promise<{ code: number; reason: string }>
      | undefined;
    const unauthorized = await unauthorizedFixture.app.injectWS(
      `/v1/tasks/${taskId}/sdk`,
      {},
      {
        onInit(socket): void {
          unauthorizedClose = nextClose(socket);
        },
      },
    );
    await expect(unauthorizedClose).resolves.toEqual(
      sdkWebSocketClose.authenticationFailed,
    );
    unauthorized.terminate();

    const missingFixture = await createFixture(apps, { taskExists: false });
    let missingClose: Promise<{ code: number; reason: string }> | undefined;
    const missing = await missingFixture.app.injectWS(
      `/v1/tasks/${taskId}/sdk`,
      { headers: { authorization: "Bearer access-token" } },
      {
        onInit(socket): void {
          missingClose = nextClose(socket);
        },
      },
    );
    await expect(missingClose).resolves.toEqual(sdkWebSocketClose.taskNotFound);
    missing.terminate();

    const revokedFixture = await createFixture(apps);
    const revoked = await revokedFixture.app.injectWS(
      `/v1/tasks/${taskId}/sdk`,
      { headers: { authorization: "Bearer access-token" } },
    );
    const revokedClose = nextClose(revoked);
    revokedFixture.connectionRegistry.closeDeviceConnections(deviceId);
    await expect(revokedClose).resolves.toEqual({
      code: 4_003,
      reason: "Device session revoked.",
    });
  });

  it("closes a terminal task SDK socket without closing control sockets", async () => {
    const fixture = await createFixture(apps);
    let controlSocketClosed = false;
    fixture.connectionRegistry.add(deviceId, {
      close(): void {
        controlSocketClosed = true;
      },
    });
    const client = await fixture.app.injectWS(`/v1/tasks/${taskId}/sdk`, {
      headers: { authorization: "Bearer access-token" },
    });
    const closed = nextClose(client);

    fixture.taskConnectionRegistry.closeTaskConnections(taskId);

    await expect(closed).resolves.toEqual(sdkWebSocketClose.sessionUnavailable);
    expect(controlSocketClosed).toBe(false);
  });
});

async function createFixture(
  apps: Array<Awaited<ReturnType<typeof createHttpApp>>>,
  options: {
    activationMessage?: SDKMessage;
    authenticate?: boolean;
    taskExists?: boolean;
  } = {},
): Promise<{
  app: Awaited<ReturnType<typeof createHttpApp>>;
  activationObservedSubscriber: boolean[];
  connectionRegistry: InMemoryDeviceConnectionRegistry;
  journal: RecordingSdkJournal;
  submissions: SDKUserMessage[];
  taskConnectionRegistry: InMemoryTaskSdkConnectionRegistry;
}> {
  const app = await createHttpApp({ websocket: true });
  const connectionRegistry = new InMemoryDeviceConnectionRegistry();
  const journal = new RecordingSdkJournal();
  const submissions: SDKUserMessage[] = [];
  const activationObservedSubscriber: boolean[] = [];
  const taskConnectionRegistry = new InMemoryTaskSdkConnectionRegistry();
  registerTaskSdkRoutes(app, {
    connectionRegistry,
    deviceAuthService: {
      authenticateAccessToken(): { id: string } {
        if (options.authenticate === false) {
          throw new Error("invalid access token");
        }
        return { id: deviceId };
      },
    },
    eventJournal: journal,
    taskConnectionRegistry,
    taskManager: {
      async activateSdkSession(): Promise<void> {
        activationObservedSubscriber.push(journal.subscriber !== undefined);
        if (options.activationMessage !== undefined) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          journal.subscriber?.send(options.activationMessage);
        }
      },
      getTask(): TaskSnapshot {
        if (options.taskExists === false) {
          throw new TaskError("TASK_NOT_FOUND", 404, "Task not found.");
        }
        return taskSnapshot();
      },
      async submitSdkMessage(input): Promise<TaskSnapshot> {
        submissions.push(input.message);
        return taskSnapshot();
      },
    },
  });
  await app.ready();
  apps.push(app);
  return {
    activationObservedSubscriber,
    app,
    connectionRegistry,
    journal,
    submissions,
    taskConnectionRegistry,
  };
}

class RecordingSdkJournal {
  afterUuid: string | undefined;
  subscriber: TaskSdkMessageSubscriber | undefined;
  taskId: string | undefined;

  public subscribeSdk(
    task: string,
    afterUuid: string | undefined,
    subscriber: TaskSdkMessageSubscriber,
  ): () => void {
    this.afterUuid = afterUuid;
    this.subscriber = subscriber;
    this.taskId = task;
    return () => {
      this.subscriber = undefined;
    };
  }
}

function taskSnapshot(): TaskSnapshot {
  return {
    createdAt: 1,
    id: taskId,
    initialCwd: "C:\\workspace",
    interruptedAt: null,
    model: null,
    origin: "pocketpilot",
    permissionMode: "default",
    sdkSessionId: null,
    state: "idle",
    terminalAt: null,
    updatedAt: 1,
  };
}

function nextMessage(socket: {
  once(event: "message", listener: (data: Buffer) => void): unknown;
}): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once("message", (data) =>
      resolve(JSON.parse(data.toString("utf8"))),
    );
  });
}

function nextClose(socket: {
  once(
    event: "close",
    listener: (code: number, reason: Buffer) => void,
  ): unknown;
}): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for WebSocket work.");
}
