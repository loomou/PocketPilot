import { randomUUID } from "node:crypto";

import type {
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { openClaudeSdkSession } from "../../src/claude-sdk/session.js";
import { installedClaudeSessionCatalog } from "../../src/claude-sdk/session-catalog.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";
import { TaskError } from "../../src/tasks/errors.js";
import { writeTaskRuntimeSettings } from "../../src/tasks/settings.js";
import type {
  TaskControlEvent,
  TaskControlEventEnvelope,
  TaskEventSink,
} from "../../src/tasks/task-events.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { readLiveSdkTestConfig } from "./live-test-config.js";

const deviceId = "00000000-0000-4000-8000-000000000001";
const sdkEventTimeoutMilliseconds = 180_000;
const sdkControlTimeoutMilliseconds = 30_000;
const catalogTimeoutMilliseconds = 30_000;
const liveConfig = readLiveSdkTestConfig();

describe.runIf(liveConfig.enabled)("Claude Agent SDK live contracts", () => {
  it("runs two direct turns and resumes the same session through TaskManager", async () => {
    if (!liveConfig.enabled) {
      throw new Error("The Claude SDK live test configuration is disabled.");
    }

    const sessionId = await runDirectSdkPhase(liveConfig.cwd);
    const sessionInfo = await waitForSessionInfo(liveConfig.cwd, sessionId);
    expect(sessionInfo.sessionId).toBe(sessionId);
    if (sessionInfo.firstPrompt !== undefined) {
      expect(sessionInfo.firstPrompt).toContain("POCKETPILOT_LIVE_TEST");
    }
    expect(
      (await waitForTerminalVisibleSession(liveConfig.cwd, sessionId))
        .sessionId,
    ).toBe(sessionId);

    await runTaskManagerPhase(liveConfig.cwd, sessionId);
  }, 600_000);
});

async function runDirectSdkPhase(cwd: string): Promise<string> {
  const session = openClaudeSdkSession(
    {
      cwd,
      permissionMode: "plan",
    },
    query,
  );
  const events = session.events();

  try {
    session.submit(
      sdkUserMessage(
        "POCKETPILOT_LIVE_TEST TURN_1. Reply briefly. Do not use tools or modify files.",
      ),
    );
    const initMessage = await waitForSdkMessage(
      events,
      (message) => message.type === "system" && message.subtype === "init",
      "system/init",
    );
    if (initMessage.type !== "system" || initMessage.subtype !== "init") {
      throw new Error("Claude SDK emitted an invalid initialization message.");
    }
    const init = initMessage;
    expect(init).toMatchObject({
      permissionMode: "plan",
      type: "system",
    });

    const sessionId = session.sessionId;
    if (sessionId === undefined) {
      throw new Error("Claude SDK init did not expose a session ID.");
    }
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const initialization = await withDeadline(
      session.initialize(),
      sdkControlTimeoutMilliseconds,
      "SDK initialization",
    );
    const firstModel = initialization.models[0];
    if (firstModel === undefined) {
      throw new Error("Claude SDK returned no supported models.");
    }
    expect(firstModel).toEqual(
      expect.objectContaining({
        displayName: expect.any(String),
        value: expect.any(String),
      }),
    );
    expectSuccessfulResult(
      await waitForSdkMessage(
        events,
        (message) => message.type === "result",
        "first result",
      ),
    );

    await withDeadline(
      session.setModel(init.model),
      sdkControlTimeoutMilliseconds,
      "model control",
    );
    await withDeadline(
      session.setPermissionMode("plan"),
      sdkControlTimeoutMilliseconds,
      "permission control",
    );
    await withDeadline(
      session.setEffortLevel(null),
      sdkControlTimeoutMilliseconds,
      "effort control",
    );

    session.submit(
      sdkUserMessage(
        "POCKETPILOT_LIVE_TEST TURN_2. Reply briefly. Do not use tools or modify files.",
      ),
    );
    expectSuccessfulResult(
      await waitForSdkMessage(
        events,
        (message) => message.type === "result",
        "second result",
      ),
    );
    return sessionId;
  } finally {
    await bestEffortCleanup(() =>
      withDeadline(
        session.interrupt(),
        sdkControlTimeoutMilliseconds,
        "direct SDK interrupt cleanup",
      ),
    );
    session.close();
    await bestEffortCleanup(() =>
      withDeadline(
        events.return(undefined),
        sdkControlTimeoutMilliseconds,
        "direct SDK event cleanup",
      ),
    );
  }
}

async function runTaskManagerPhase(
  cwd: string,
  sessionId: string,
): Promise<void> {
  const connection = openStorage({ databasePath: ":memory:" });
  const settingsRepository = new SettingsRepository(connection.database);
  const eventSink = new RecordingTaskEventSink();
  seedDevice(connection);
  writeTaskRuntimeSettings(settingsRepository, {
    concurrentTaskCapacity: 1,
    workspaceRoots: [cwd],
  });
  const manager = new TaskManager({
    eventSink,
    settingsRepository,
    sqlite: connection.database,
  });

  try {
    const attached = await manager.attachClaudeSession({
      deviceId,
      operationId: randomUUID(),
      sessionId,
      workspace: cwd,
      workspaceRiskAccepted: true,
    });
    expect(attached).toMatchObject({
      action: "attached",
      task: {
        origin: "claude-session",
        sdkSessionId: sessionId,
        state: "idle",
      },
    });
    const taskId = attached.task.id;

    await withDeadline(
      manager.activateSdkSession(taskId),
      sdkEventTimeoutMilliseconds,
      "TaskManager SDK activation",
    );

    const composer = await withDeadline(
      manager.getComposerOptions(taskId),
      sdkControlTimeoutMilliseconds,
      "TaskManager composer options",
    );
    if (composer.models.length === 0) {
      throw new Error("TaskManager returned no supported models.");
    }
    expect(composer.supportedPermissionModes).toContain("plan");

    const appendOnly = await manager.submitSdkMessage({
      deviceId,
      message: sdkUserMessage(
        "POCKETPILOT_LIVE_TEST CONTEXT_ONLY. Synthetic context; do not use tools or modify files.",
        { shouldQuery: false },
      ),
      taskId,
    });
    expect(appendOnly.state).toBe("idle");

    await waitForCondition(
      () =>
        eventSink.sdkMessages.some(
          (message) => message.type === "system" && message.subtype === "init",
        ),
      "TaskManager system/init",
    );
    const resumedInit = eventSink.sdkMessages.find(
      (message) => message.type === "system" && message.subtype === "init",
    );
    if (
      resumedInit === undefined ||
      resumedInit.type !== "system" ||
      resumedInit.subtype !== "init"
    ) {
      throw new Error(
        "TaskManager published an invalid initialization message.",
      );
    }
    expect(resumedInit.session_id).toBe(sessionId);

    await withDeadline(
      manager.setModel({
        deviceId,
        model: resumedInit.model,
        operationId: randomUUID(),
        taskId,
      }),
      sdkControlTimeoutMilliseconds,
      "TaskManager model control",
    );
    await withDeadline(
      manager.setPermissionMode({
        deviceId,
        operationId: randomUUID(),
        permissionMode: "plan",
        taskId,
      }),
      sdkControlTimeoutMilliseconds,
      "TaskManager permission control",
    );
    await withDeadline(
      manager.setEffortLevel({
        deviceId,
        effortLevel: null,
        operationId: randomUUID(),
        taskId,
      }),
      sdkControlTimeoutMilliseconds,
      "TaskManager effort control",
    );

    const sdkMessageStart = eventSink.sdkMessages.length;
    const executing = await manager.submitSdkMessage({
      deviceId,
      message: sdkUserMessage(
        "POCKETPILOT_LIVE_TEST TURN_3. Reply briefly. Do not use tools or modify files.",
      ),
      taskId,
    });
    expect(executing.state).toBe("executing");

    const result = await waitForTaskManagerResult(
      manager,
      taskId,
      eventSink.sdkMessages,
      sdkMessageStart,
    );
    await waitForCondition(
      () => manager.getTask(taskId).state === "idle",
      "TaskManager idle state",
    );

    expectSuccessfulResult(result);
    expect(manager.getTask(taskId)).toMatchObject({
      sdkSessionId: sessionId,
      state: "idle",
    });

    const history = await waitForHistory(manager, cwd, sessionId);
    expect(history.messages.length).toBeGreaterThan(0);
    expect(
      history.messages.every((message) => message.session_id === sessionId),
    ).toBe(true);
    expect(
      (await waitForTerminalVisibleSession(cwd, sessionId)).sessionId,
    ).toBe(sessionId);
    expect(eventSink.taskStates()).toEqual(
      expect.arrayContaining(["executing", "idle"]),
    );

    const interrupted = await withDeadline(
      manager.interruptTask({
        deviceId,
        operationId: randomUUID(),
        taskId,
      }),
      sdkControlTimeoutMilliseconds,
      "TaskManager interrupt",
    );
    expect(interrupted).toMatchObject({
      action: "interrupted",
      task: { state: "idle" },
    });
  } finally {
    await bestEffortCleanup(() =>
      withDeadline(
        manager.shutdown(),
        sdkControlTimeoutMilliseconds,
        "TaskManager shutdown",
      ),
    );
    connection.close();
  }
}

async function waitForSessionInfo(
  cwd: string,
  sessionId: string,
): Promise<SDKSessionInfo> {
  return waitForValue(
    async () =>
      installedClaudeSessionCatalog.getInfo(sessionId, {
        dir: cwd,
      }),
    "SDK session catalog",
  );
}

async function waitForTerminalVisibleSession(
  cwd: string,
  sessionId: string,
): Promise<SDKSessionInfo> {
  return waitForValue(async () => {
    const sessions = await installedClaudeSessionCatalog.list({
      dir: cwd,
      includeProgrammatic: false,
      includeWorktrees: false,
      limit: 100,
    });
    return sessions.find((session) => session.sessionId === sessionId);
  }, "terminal-visible SDK session catalog");
}

async function waitForHistory(
  manager: TaskManager,
  workspace: string,
  sessionId: string,
) {
  return waitForValue(async () => {
    try {
      return await manager.readClaudeSessionHistory({ sessionId, workspace });
    } catch (error) {
      if (
        error instanceof TaskError &&
        (error.code === "CLAUDE_HISTORY_UNAVAILABLE" ||
          error.code === "CLAUDE_SESSION_NOT_FOUND")
      ) {
        return undefined;
      }
      throw error;
    }
  }, "TaskManager session history");
}

async function waitForValue<T>(
  read: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const expiresAt = Date.now() + catalogTimeoutMilliseconds;
  while (Date.now() < expiresAt) {
    const remaining = expiresAt - Date.now();
    const value = await withDeadline(read(), remaining, label);
    if (value !== undefined) {
      return value;
    }
    await delay(Math.min(250, Math.max(0, expiresAt - Date.now())));
  }
  throw new Error(`${label} was unavailable before the live test deadline.`);
}

async function waitForSdkMessage(
  events: AsyncIterator<SDKMessage>,
  matches: (message: SDKMessage) => boolean,
  label: string,
): Promise<SDKMessage> {
  const expiresAt = Date.now() + sdkEventTimeoutMilliseconds;
  const observedCategories = new Set<string>();
  while (true) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `${label} was not emitted before the live test deadline; observed ${formatSdkMessageCategories(observedCategories)}.`,
      );
    }
    let event: IteratorResult<SDKMessage>;
    try {
      event = await withDeadline(events.next(), remaining, label);
    } catch {
      throw new Error(
        `${label} was unavailable before the live test deadline; observed ${formatSdkMessageCategories(observedCategories)}.`,
      );
    }
    if (event.done) {
      throw new Error(`Claude SDK ended before emitting ${label}.`);
    }
    observedCategories.add(sdkMessageCategory(event.value));
    if (matches(event.value)) {
      return event.value;
    }
  }
}

async function waitForTaskManagerResult(
  manager: TaskManager,
  taskId: string,
  sdkMessages: readonly SDKMessage[],
  startIndex: number,
): Promise<SDKMessage> {
  try {
    await waitForCondition(
      () =>
        sdkMessages
          .slice(startIndex)
          .some((message) => message.type === "result") ||
        manager.getTask(taskId).state === "idle",
      "TaskManager result",
    );
  } catch {
    throw taskManagerResultError(manager, taskId, sdkMessages, startIndex);
  }

  const result = sdkMessages
    .slice(startIndex)
    .find((message) => message.type === "result");
  if (result === undefined) {
    throw taskManagerResultError(manager, taskId, sdkMessages, startIndex);
  }
  return result;
}

function taskManagerResultError(
  manager: TaskManager,
  taskId: string,
  sdkMessages: readonly SDKMessage[],
  startIndex: number,
): Error {
  const categories = new Set(
    sdkMessages.slice(startIndex).map(sdkMessageCategory),
  );
  return new Error(
    `TaskManager result was unavailable in state ${manager.getTask(taskId).state}; observed ${formatSdkMessageCategories(categories)}.`,
  );
}

function sdkMessageCategory(message: SDKMessage): string {
  if ("subtype" in message && typeof message.subtype === "string") {
    return `${message.type}/${message.subtype}`;
  }
  return message.type;
}

function formatSdkMessageCategories(categories: ReadonlySet<string>): string {
  return categories.size === 0 ? "no SDK messages" : [...categories].join(", ");
}

async function waitForCondition(
  condition: () => boolean,
  label: string,
): Promise<void> {
  const expiresAt = Date.now() + sdkEventTimeoutMilliseconds;
  while (Date.now() < expiresAt) {
    if (condition()) {
      return;
    }
    await delay(50);
  }
  throw new Error(`${label} was unavailable before the live test deadline.`);
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} exceeded the live test deadline.`)),
      timeoutMilliseconds,
    );
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

function expectSuccessfulResult(message: SDKMessage): void {
  if (message.type !== "result") {
    throw new Error("Expected a Claude SDK result message.");
  }
  expect(message).toMatchObject({
    is_error: false,
    subtype: "success",
    type: "result",
  });
}

function sdkUserMessage(
  content: string,
  overrides: Partial<SDKUserMessage> = {},
): SDKUserMessage {
  return {
    message: { content, role: "user" },
    origin: { kind: "human" },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString(),
    type: "user",
    uuid: randomUUID(),
    ...overrides,
  };
}

function seedDevice(connection: StorageConnection): void {
  connection.sqlite
    .prepare(
      "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(deviceId, "SDK live test device", "synthetic-public-key", Date.now());
}

async function bestEffortCleanup(
  cleanup: () => Promise<unknown>,
): Promise<void> {
  try {
    await cleanup();
  } catch {
    // The primary live assertion remains the failure signal.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RecordingTaskEventSink implements TaskEventSink {
  readonly controlEvents: TaskControlEventEnvelope[] = [];
  readonly sdkMessages: SDKMessage[] = [];
  #nextCursor = 0;

  public beginTurn(_taskId: string): void {}

  public endTurn(_taskId: string): void {}

  public publishControlEvent(
    taskId: string,
    event: TaskControlEvent,
  ): TaskControlEventEnvelope {
    const envelope = {
      cursor: this.#nextCursor,
      event,
      occurredAt: Date.now(),
      taskId,
    };
    this.#nextCursor += 1;
    this.controlEvents.push(envelope);
    return envelope;
  }

  public publishSdkMessage(_taskId: string, message: SDKMessage): void {
    this.sdkMessages.push(message);
  }

  public taskStates(): string[] {
    return this.controlEvents.flatMap((envelope) =>
      envelope.event.kind === "task.state" &&
      typeof envelope.event.payload === "object" &&
      envelope.event.payload !== null &&
      "state" in envelope.event.payload &&
      typeof envelope.event.payload.state === "string"
        ? [envelope.event.payload.state]
        : [],
    );
  }
}
