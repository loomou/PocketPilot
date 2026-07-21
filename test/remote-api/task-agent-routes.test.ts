import { randomUUID } from "node:crypto";

import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentProviderAdapter } from "../../src/agent-providers/types.js";
import { InMemoryDeviceConnectionRegistry } from "../../src/auth/device-connection-registry.js";
import { parseSdkUserMessageFrame } from "../../src/claude-sdk/transport.js";
import { CodexNativeJournal } from "../../src/codex-app-server/journal.js";
import { parseCodexClientFrame } from "../../src/codex-app-server/protocol.js";
import { createHttpApp } from "../../src/http/create-http-app.js";
import { createPocketPilotLogger } from "../../src/logging/logger.js";
import { InMemoryTaskAgentConnectionRegistry } from "../../src/remote-api/task-agent-connection-registry.js";
import {
  agentWebSocketClose,
  registerTaskAgentRoutes,
} from "../../src/remote-api/task-agent-routes.js";
import { TaskError } from "../../src/tasks/errors.js";
import type { TaskSnapshot } from "../../src/tasks/task-types.js";

const deviceId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";

describe("task Agent WebSocket", () => {
  const apps: Array<Awaited<ReturnType<typeof createHttpApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("passes provider-native frames unchanged and subscribes before activation", async () => {
    const fixture = await createFixture(apps);
    const client = await fixture.app.injectWS(
      `/v1/tasks/${taskId}/agent?afterCursor=message-anchor`,
      { headers: { authorization: "Bearer access-token" } },
    );

    expect(fixture.afterCursor).toBe("message-anchor");
    await waitFor(() => fixture.activationObservedSubscriber.length === 1);
    expect(fixture.activationObservedSubscriber).toEqual([true]);

    const output = {
      type: "future_sdk_variant",
      uuid: randomUUID(),
      nested_extension: { preserved: true },
    } as unknown as SDKMessage;
    const received = nextMessage(client);
    fixture.subscriber?.send(output);
    await expect(received).resolves.toEqual(output);

    const input = {
      message: { content: "raw input", role: "user" },
      parent_tool_use_id: null,
      priority: "now",
      shouldQuery: false,
      type: "user",
      unknown_sdk_extension: { preserved: true },
    } as unknown as SDKUserMessage;
    client.send(JSON.stringify(input));
    await waitFor(() => fixture.submissions.length === 1);
    expect(fixture.submissions[0]).toEqual(input);
    expect(fixture.logs.value()).toContain("Agent WebSocket connected");
    expect(fixture.logs.value()).not.toContain("raw input");
    client.terminate();
  });

  it("closes invalid native input with the common Agent close code", async () => {
    const fixture = await createFixture(apps);
    const client = await fixture.app.injectWS(`/v1/tasks/${taskId}/agent`, {
      headers: { authorization: "Bearer access-token" },
    });
    const closed = nextClose(client);
    client.send(JSON.stringify({ type: "event", payload: {} }));

    await expect(closed).resolves.toEqual(agentWebSocketClose.messageInvalid);
    expect(fixture.submissions).toEqual([]);
  });

  it("replays the complete retained Codex turn without wrapping native frames", async () => {
    const journal = new CodexNativeJournal();
    const provider = codexReplayProvider(journal);
    const fixture = await createFixture(apps, {
      provider,
      snapshot: taskSnapshot("codex"),
    });
    const first = {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    };
    const second = {
      method: "item/agentMessage/delta",
      params: { delta: "hello", itemId: "item-1", threadId: "thread-1" },
    };
    journal.beginTurn(taskId);
    journal.publish(taskId, first);
    journal.publish(taskId, second);
    const checkpoint = {
      kind: "agent.checkpoint",
      payload: {
        cursor: "2",
        provider: "codex",
      },
    };

    const initialMessages: unknown[] = [];
    const initial = await fixture.app.injectWS(
      `/v1/tasks/${taskId}/agent`,
      { headers: { authorization: "Bearer access-token" } },
      { onInit: (socket) => collectMessages(socket, initialMessages) },
    );
    await waitFor(() => initialMessages.length === 3);
    expect(initialMessages).toEqual([checkpoint, first, second]);
    expect(initialMessages[1]).toEqual(first);
    expect(Object.hasOwn(initialMessages[1] as object, "cursor")).toBe(false);
    const live = {
      method: "item/completed",
      params: { item: { id: "item-1" }, threadId: "thread-1" },
    };
    journal.publish(taskId, live);
    await waitFor(() => initialMessages.length === 4);
    expect(initialMessages[3]).toEqual(live);
    initial.terminate();

    const fallbackMessages: unknown[] = [];
    const fallback = await fixture.app.injectWS(
      `/v1/tasks/${taskId}/agent?afterCursor=evicted-cursor`,
      { headers: { authorization: "Bearer access-token" } },
      { onInit: (socket) => collectMessages(socket, fallbackMessages) },
    );
    await waitFor(() => fallbackMessages.length === 4);
    expect(fallbackMessages).toEqual([
      {
        kind: "agent.checkpoint",
        payload: {
          cursor: "3",
          provider: "codex",
        },
      },
      first,
      second,
      live,
    ]);
    fallback.terminate();

    const knownMessages: unknown[] = [];
    const known = await fixture.app.injectWS(
      `/v1/tasks/${taskId}/agent?afterCursor=2`,
      { headers: { authorization: "Bearer access-token" } },
      { onInit: (socket) => collectMessages(socket, knownMessages) },
    );
    await waitFor(() => knownMessages.length === 2);
    expect(knownMessages).toEqual([
      {
        kind: "agent.checkpoint",
        payload: {
          cursor: "3",
          provider: "codex",
        },
      },
      live,
    ]);
    known.terminate();

    const nextTurn = {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2" } },
    };
    journal.beginTurn(taskId);
    journal.publish(taskId, nextTurn);
    const nextTurnMessages: unknown[] = [];
    const next = await fixture.app.injectWS(
      `/v1/tasks/${taskId}/agent`,
      { headers: { authorization: "Bearer access-token" } },
      { onInit: (socket) => collectMessages(socket, nextTurnMessages) },
    );
    await waitFor(() => nextTurnMessages.length === 2);
    expect(nextTurnMessages).toEqual([
      {
        kind: "agent.checkpoint",
        payload: {
          cursor: "4",
          provider: "codex",
        },
      },
      nextTurn,
    ]);
    next.terminate();
  });

  it("uses stable close codes for authentication and missing tasks", async () => {
    const unauthorizedFixture = await createFixture(apps, {
      authenticate: false,
    });
    let unauthorizedClose: Promise<WebSocketFailure> | undefined;
    const unauthorized = await unauthorizedFixture.app.injectWS(
      `/v1/tasks/${taskId}/agent`,
      {},
      {
        onInit: (socket) => {
          unauthorizedClose = nextClose(socket);
        },
      },
    );
    await expect(unauthorizedClose).resolves.toEqual(
      agentWebSocketClose.authenticationFailed,
    );
    unauthorized.terminate();

    const missingFixture = await createFixture(apps, { taskExists: false });
    let missingClose: Promise<WebSocketFailure> | undefined;
    const missing = await missingFixture.app.injectWS(
      `/v1/tasks/${taskId}/agent`,
      { headers: { authorization: "Bearer access-token" } },
      {
        onInit: (socket) => {
          missingClose = nextClose(socket);
        },
      },
    );
    await expect(missingClose).resolves.toEqual(
      agentWebSocketClose.taskNotFound,
    );
    missing.terminate();
  });

  it("keeps task-native sockets separate from control sockets", async () => {
    const fixture = await createFixture(apps);
    let controlSocketClosed = false;
    fixture.connectionRegistry.add(deviceId, {
      close(): void {
        controlSocketClosed = true;
      },
    });
    const client = await fixture.app.injectWS(`/v1/tasks/${taskId}/agent`, {
      headers: { authorization: "Bearer access-token" },
    });
    const closed = nextClose(client);
    fixture.taskConnectionRegistry.closeTaskConnections(taskId);

    await expect(closed).resolves.toEqual(
      agentWebSocketClose.sessionUnavailable,
    );
    expect(controlSocketClosed).toBe(false);
  });
});

async function createFixture(
  apps: Array<Awaited<ReturnType<typeof createHttpApp>>>,
  options: {
    authenticate?: boolean;
    provider?: AgentProviderAdapter;
    snapshot?: TaskSnapshot;
    taskExists?: boolean;
  } = {},
) {
  const app = await createHttpApp({ websocket: true });
  const logs = createCapture();
  const connectionRegistry = new InMemoryDeviceConnectionRegistry();
  const taskConnectionRegistry = new InMemoryTaskAgentConnectionRegistry();
  const submissions: unknown[] = [];
  const activationObservedSubscriber: boolean[] = [];
  let subscriber: { send(message: unknown): void } | undefined;
  let afterCursor: string | undefined;
  const defaultProvider: AgentProviderAdapter = {
    descriptor: {
      displayName: "Claude Code",
      id: "claude",
      protocolVersion: "@anthropic-ai/claude-agent-sdk@0.3.210",
      status: "available",
    },
    taskStream: {
      async activate(): Promise<void> {
        activationObservedSubscriber.push(subscriber !== undefined);
      },
      parseClientFrame: parseSdkUserMessageFrame,
      async submit(input): Promise<TaskSnapshot> {
        submissions.push(input.message);
        return taskSnapshot();
      },
      subscribe(_task, after, nextSubscriber): () => void {
        afterCursor = after;
        subscriber = nextSubscriber;
        return () => {
          subscriber = undefined;
        };
      },
    },
    attachConversation: async () => {
      throw new Error("not used");
    },
    createConversation: async () => {
      throw new Error("not used");
    },
    listConversations: async () => ({
      items: [],
      page: { cursor: null, hasMore: false },
    }),
    readConversation: async () => ({
      items: [],
      page: { cursor: null, hasMore: false },
    }),
  };
  const provider = options.provider ?? defaultProvider;
  const snapshot = options.snapshot ?? taskSnapshot();
  registerTaskAgentRoutes(app, {
    agentRuntimeManager: {
      task(): TaskSnapshot {
        if (options.taskExists === false) {
          throw new TaskError("TASK_NOT_FOUND", 404, "Task not found.");
        }
        return snapshot;
      },
      taskProvider(): AgentProviderAdapter {
        if (options.taskExists === false) {
          throw new TaskError("TASK_NOT_FOUND", 404, "Task not found.");
        }
        return provider;
      },
    },
    connectionRegistry,
    deviceAuthService: {
      authenticateAccessToken(): { id: string } {
        if (options.authenticate === false) {
          throw new Error("invalid access token");
        }
        return { id: deviceId };
      },
    },
    logger: createPocketPilotLogger({
      color: false,
      destination: logs,
      level: "info",
    }),
    taskConnectionRegistry,
  });
  await app.ready();
  apps.push(app);
  return {
    activationObservedSubscriber,
    get afterCursor() {
      return afterCursor;
    },
    app,
    connectionRegistry,
    logs,
    submissions,
    get subscriber() {
      return subscriber;
    },
    taskConnectionRegistry,
  };
}

function taskSnapshot(provider: "claude" | "codex" = "claude"): TaskSnapshot {
  return {
    activeTurnId: null,
    createdAt: 1,
    id: taskId,
    initialCwd: "C:\\workspace",
    interruptedAt: null,
    model: null,
    nativeConversationId: provider === "codex" ? "thread-1" : null,
    nativeProtocolVersion:
      provider === "codex" ? "0.144" : "@anthropic-ai/claude-agent-sdk@0.3.210",
    nativeSessionId: provider === "codex" ? "session-1" : null,
    origin: provider === "codex" ? "agent-conversation" : "pocketpilot",
    permissionMode: provider === "codex" ? null : "default",
    provider,
    sdkSessionId: null,
    state: "idle",
    terminalAt: null,
    updatedAt: 1,
  };
}

function codexReplayProvider(
  journal: CodexNativeJournal,
): AgentProviderAdapter {
  return {
    descriptor: {
      displayName: "Codex CLI",
      id: "codex",
      protocolVersion: "0.144",
      status: "available",
    },
    taskStream: {
      activate: async () => undefined,
      parseClientFrame: parseCodexClientFrame,
      submit: async () => taskSnapshot("codex"),
      subscribe: (task, afterCursor, subscriber) =>
        journal.subscribe(task, afterCursor, subscriber),
    },
    attachConversation: async () => {
      throw new Error("not used");
    },
    createConversation: async () => {
      throw new Error("not used");
    },
    listConversations: async () => ({
      items: [],
      page: { cursor: null, hasMore: false },
    }),
    readConversation: async () => ({
      items: [],
      page: { cursor: null, hasMore: false },
    }),
  };
}

function collectMessages(
  socket: {
    on(event: "message", listener: (data: Buffer) => void): unknown;
  },
  messages: unknown[],
): void {
  socket.on("message", (data) => {
    messages.push(JSON.parse(data.toString("utf8")));
  });
}

type WebSocketFailure = { code: number; reason: string };

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
}): Promise<WebSocketFailure> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString("utf8") }),
    );
  });
}

function createCapture() {
  let output = "";
  return {
    isTTY: false as const,
    value: () => output,
    write(chunk: string): void {
      output += chunk;
    },
  };
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
