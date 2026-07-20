import { afterEach, describe, expect, it } from "vitest";

import { InMemoryDeviceConnectionRegistry } from "../../src/auth/device-connection-registry.js";
import { createHttpApp } from "../../src/http/create-http-app.js";
import { createPocketPilotLogger } from "../../src/logging/logger.js";
import { registerTaskEventRoutes } from "../../src/remote-api/task-event-routes.js";
import type { TaskControlEventSubscriber } from "../../src/tasks/task-events.js";

const deviceId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";

describe("task control WebSocket", () => {
  const apps: Array<Awaited<ReturnType<typeof createHttpApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("subscribes only to PocketPilot control envelopes", async () => {
    const app = await createHttpApp({ websocket: true });
    const logs = createCapture();
    const logger = createPocketPilotLogger({
      color: false,
      destination: logs,
      level: "info",
    });
    let subscriber: TaskControlEventSubscriber | undefined;
    registerTaskEventRoutes(app, {
      connectionRegistry: new InMemoryDeviceConnectionRegistry(),
      deviceAuthService: {
        authenticateAccessToken(): { id: string } {
          return { id: deviceId };
        },
      },
      eventJournal: {
        subscribeControl(_taskId, _afterCursor, nextSubscriber): () => void {
          subscriber = nextSubscriber;
          return () => {
            subscriber = undefined;
          };
        },
      },
      logger,
    });
    await app.ready();
    apps.push(app);
    const client = await app.injectWS("/v1/events", {
      headers: { authorization: "Bearer access-token" },
    });

    const subscribed = nextMessage(client);
    client.send(JSON.stringify({ afterCursor: -1, taskId, type: "subscribe" }));
    await expect(subscribed).resolves.toEqual({
      afterCursor: -1,
      taskId,
      type: "subscribed",
    });

    const delivered = nextMessage(client);
    subscriber?.send({
      cursor: 0,
      event: {
        kind: "approval.requested",
        payload: {
          input: { file_path: "README.md" },
          options: { requestId: "request-1", toolUseID: "tool-1" },
          toolName: "Read",
        },
      },
      occurredAt: 1,
      taskId,
    });
    await expect(delivered).resolves.toEqual({
      event: {
        cursor: 0,
        event: {
          kind: "approval.requested",
          payload: {
            input: { file_path: "README.md" },
            options: { requestId: "request-1", toolUseID: "tool-1" },
            toolName: "Read",
          },
        },
        occurredAt: 1,
        taskId,
      },
      type: "event",
    });

    const codexApproval = nextMessage(client);
    subscriber?.send({
      cursor: 1,
      event: {
        kind: "approval.requested",
        payload: {
          method: "item/fileChange/requestApproval",
          params: { itemId: "item-1", threadId: "thread-1", turnId: "turn-1" },
          provider: "codex",
          requestId: "approval-1",
        },
      },
      occurredAt: 2,
      taskId,
    });
    await expect(codexApproval).resolves.toEqual({
      event: {
        cursor: 1,
        event: {
          kind: "approval.requested",
          payload: {
            method: "item/fileChange/requestApproval",
            params: {
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
            provider: "codex",
            requestId: "approval-1",
          },
        },
        occurredAt: 2,
        taskId,
      },
      type: "event",
    });
    client.terminate();
    expect(logs.value()).toContain("Control WebSocket connected");
    expect(logs.value()).toContain("Control WebSocket subscribed");
    expect(logs.value()).not.toContain("file_path");
  });
});

function createCapture(): {
  isTTY: false;
  value(): string;
  write(chunk: string): void;
} {
  let output = "";
  return {
    isTTY: false,
    value: () => output,
    write(chunk): void {
      output += chunk;
    },
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
