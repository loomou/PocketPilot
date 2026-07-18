import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  EffortLevel,
  ModelInfo,
  PermissionMode,
  ResolvedSettings,
  SDKControlInitializeResponse,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClaudeSdkInitialization,
  OpenClaudeSdkSessionOptions,
} from "../../src/claude-sdk/session.js";
import type { ClaudeSessionCatalog } from "../../src/claude-sdk/session-catalog.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";
import { writeTaskRuntimeSettings } from "../../src/tasks/settings.js";
import {
  TaskManager,
  type TaskSdkSession,
} from "../../src/tasks/task-manager.js";

const deviceId = "00000000-0000-4000-8000-000000000001";

describe("Claude session-centric task manager", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await fixture.manager.shutdown();
      fixture.connection.close();
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });

  it("lists only in-workspace SDK sessions with explicit SDK scope options", async () => {
    const fixture = createFixture(fixtures);
    const inside = sdkSession("inside", fixture.workspace, {
      futureSdkField: { preserved: true },
    });
    const outside = sdkSession("outside", fixture.outside);
    const missingCwd = sdkSession("missing-cwd");
    fixture.catalog.sessions = [inside, outside, missingCwd];

    const page = await fixture.manager.listClaudeSessions({
      limit: 3,
      offset: 6,
      workspace: fixture.workspace,
    });

    expect(page.sessions).toEqual([inside, missingCwd]);
    expect(page.sessions[0]).toBe(inside);
    expect(page.nextOffset).toBe(9);
    expect(fixture.catalog.listCalls).toEqual([
      {
        dir: fixture.workspace,
        includeProgrammatic: true,
        includeWorktrees: false,
        limit: 3,
        offset: 6,
      },
    ]);
  });

  it("returns no session metadata when P0 revokes an in-flight catalog read", async () => {
    const fixture = createFixture(fixtures);
    fixture.catalog.sessions = [sdkSession("inside", fixture.workspace)];
    const gate = fixture.catalog.deferNextList();
    const snapshot = await fixture.manager.authorizedDirectorySnapshot();
    const root = snapshot.directories[0];
    if (root === undefined) {
      throw new Error("The fixture has no authorized root.");
    }

    const pending = fixture.manager.listClaudeSessions({
      workspace: fixture.workspace,
    });
    await gate.started;
    await expect(
      fixture.manager.removeAuthorizedDirectory({
        expectedNonTerminalRuntimeCount: 0,
        path: root.path,
        revision: snapshot.revision,
        runtimeStopAccepted: true,
      }),
    ).resolves.toMatchObject({ stoppedTaskCount: 0 });
    gate.release();

    await expect(pending).rejects.toMatchObject({
      code: "WORKSPACE_NOT_AUTHORIZED",
    });
  });

  it("returns latest and older unchanged history pages and serializes reads", async () => {
    const fixture = createFixture(fixtures);
    const session = sdkSession("history-session", fixture.workspace);
    const messages = Array.from({ length: 120 }, (_, index) =>
      sdkHistoryMessage(index, session.sessionId),
    );
    fixture.catalog.sessions = [session];
    fixture.catalog.messages.set(session.sessionId, messages);
    fixture.catalog.readDelayMilliseconds = 5;

    const [latest, duplicateLatest] = await Promise.all([
      fixture.manager.readClaudeSessionHistory({
        sessionId: session.sessionId,
        workspace: fixture.workspace,
      }),
      fixture.manager.readClaudeSessionHistory({
        sessionId: session.sessionId,
        workspace: fixture.workspace,
      }),
    ]);
    expect(fixture.catalog.maximumConcurrentReads).toBe(1);
    expect(latest.messages).toEqual(messages.slice(70));
    expect(latest.messages[0]).toBe(messages[70]);
    expect(latest.page).toEqual({
      beforeUuid: "message-070",
      hasMoreBefore: true,
    });
    expect(duplicateLatest).toEqual(latest);

    if (latest.page.beforeUuid === null) {
      throw new Error("The latest page did not expose its older-page cursor.");
    }
    const older = await fixture.manager.readClaudeSessionHistory({
      beforeUuid: latest.page.beforeUuid,
      includeSystemMessages: true,
      sessionId: session.sessionId,
      workspace: fixture.workspace,
    });
    expect(older.messages).toEqual(messages.slice(20, 70));
    expect(older.page).toEqual({
      beforeUuid: "message-020",
      hasMoreBefore: true,
    });
    expect(fixture.catalog.messageCalls.at(-1)).toEqual({
      dir: fixture.workspace,
      includeSystemMessages: true,
    });

    await expect(
      fixture.manager.readClaudeSessionHistory({
        beforeUuid: "removed-message",
        sessionId: session.sessionId,
        workspace: fixture.workspace,
      }),
    ).rejects.toMatchObject({ code: "HISTORY_CURSOR_STALE" });
  });

  it("keeps history failure separate from transparent attachment and Query use", async () => {
    const fixture = createFixture(fixtures);
    const session = sdkSession("resume-session", fixture.workspace);
    fixture.catalog.sessions = [session];
    fixture.catalog.historyFailure = true;

    await expect(
      fixture.manager.readClaudeSessionHistory({
        sessionId: session.sessionId,
        workspace: fixture.workspace,
      }),
    ).rejects.toMatchObject({ code: "CLAUDE_HISTORY_UNAVAILABLE" });

    const firstAttach = await fixture.manager.attachClaudeSession({
      deviceId,
      operationId: randomUUID(),
      sessionId: session.sessionId,
      workspace: fixture.workspace,
      workspaceRiskAccepted: true,
    });
    const secondAttach = await fixture.manager.attachClaudeSession({
      deviceId,
      operationId: randomUUID(),
      sessionId: session.sessionId,
      workspace: fixture.workspace,
      workspaceRiskAccepted: true,
    });
    expect(secondAttach.task.id).toBe(firstAttach.task.id);
    expect(firstAttach.task).toMatchObject({
      model: null,
      origin: "claude-session",
      permissionMode: null,
      sdkSessionId: session.sessionId,
      state: "idle",
    });

    await fixture.manager.activateSdkSession(firstAttach.task.id);
    const runtime = fixture.sessions[0];
    expect(runtime?.options).toMatchObject({
      cwd: fixture.workspace,
      resume: session.sessionId,
    });
    expect(runtime?.options).not.toHaveProperty("model");
    expect(runtime?.options).not.toHaveProperty("permissionMode");
  });

  it("starts new conversations with Claude defaults and applies live controls", async () => {
    const fixture = createFixture(fixtures);
    const created = await fixture.manager.createClaudeConversation({
      deviceId,
      operationId: randomUUID(),
      workspace: fixture.workspace,
      workspaceRiskAccepted: true,
    });
    expect(created.task).toMatchObject({
      model: null,
      origin: "claude-session",
      permissionMode: null,
      sdkSessionId: null,
      state: "idle",
    });

    await fixture.manager.activateSdkSession(created.task.id);
    const runtime = fixture.sessions[0];
    if (runtime === undefined) {
      throw new Error("The Claude runtime was not activated.");
    }
    expect(runtime.options).toMatchObject({ cwd: fixture.workspace });
    expect(runtime.options).not.toHaveProperty("resume");
    expect(runtime.options).not.toHaveProperty("model");
    expect(runtime.options).not.toHaveProperty("permissionMode");

    const composer = await fixture.manager.getComposerOptions(created.task.id);
    expect(composer).toEqual({
      effortLevel: "high",
      models: fixture.models,
      supportedPermissionModes: [
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
        "dontAsk",
        "auto",
      ],
    });
    expect(composer.models[0]).toBe(fixture.models[0]);

    await fixture.manager.submitSdkMessage({
      deviceId,
      message: sdkInput("hello"),
      taskId: created.task.id,
    });
    await fixture.manager.setModel({
      deviceId,
      model: "opus",
      operationId: randomUUID(),
      taskId: created.task.id,
    });
    await fixture.manager.setPermissionMode({
      deviceId,
      operationId: randomUUID(),
      permissionMode: "plan",
      taskId: created.task.id,
    });
    await fixture.manager.setEffortLevel({
      deviceId,
      effortLevel: "max",
      operationId: randomUUID(),
      taskId: created.task.id,
    });

    expect(runtime.models).toEqual(["opus"]);
    expect(runtime.permissionModes).toEqual(["plan"]);
    expect(runtime.effortLevels).toEqual(["max"]);
    expect(fixture.manager.getTask(created.task.id)).toMatchObject({
      model: null,
      permissionMode: null,
      state: "executing",
    });

    runtime.sessionId = "new-sdk-session";
    runtime.emit({
      session_id: runtime.sessionId,
      state: "running",
      subtype: "session_state_changed",
      type: "system",
      uuid: randomUUID(),
    } as SDKMessage);
    await waitFor(
      () =>
        fixture.manager.getTask(created.task.id).sdkSessionId ===
        "new-sdk-session",
    );
  });
});

class FakeCatalog implements ClaudeSessionCatalog {
  activeReads = 0;
  historyFailure = false;
  readonly listCalls: unknown[] = [];
  maximumConcurrentReads = 0;
  readonly messageCalls: unknown[] = [];
  readonly messages = new Map<string, SessionMessage[]>();
  readDelayMilliseconds = 0;
  sessions: SDKSessionInfo[] = [];
  #listGate: Deferred | undefined;

  public deferNextList(): DeferredControl {
    const gate = new Deferred();
    this.#listGate = gate;
    return gate.control;
  }

  public async getInfo(
    sessionId: string,
    _options: { dir?: string },
  ): Promise<SDKSessionInfo | undefined> {
    return this.sessions.find((session) => session.sessionId === sessionId);
  }

  public async getMessages(
    sessionId: string,
    options: { dir?: string; includeSystemMessages?: boolean },
  ): Promise<SessionMessage[]> {
    this.messageCalls.push(options);
    if (this.historyFailure) {
      throw new Error("history unavailable");
    }
    this.activeReads += 1;
    this.maximumConcurrentReads = Math.max(
      this.maximumConcurrentReads,
      this.activeReads,
    );
    try {
      if (this.readDelayMilliseconds > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.readDelayMilliseconds);
        });
      }
      return this.messages.get(sessionId) ?? [];
    } finally {
      this.activeReads -= 1;
    }
  }

  public async list(options: unknown): Promise<SDKSessionInfo[]> {
    this.listCalls.push(options);
    const gate = this.#listGate;
    this.#listGate = undefined;
    if (gate !== undefined) {
      gate.markStarted();
      await gate.promise;
    }
    return this.sessions;
  }

  public async resolveSettings(): Promise<ResolvedSettings> {
    return {
      effective: { effortLevel: "high" },
      provenance: {},
      sources: [],
    };
  }
}

type DeferredControl = {
  release(): void;
  started: Promise<void>;
};

class Deferred {
  readonly control: DeferredControl;
  readonly promise: Promise<void>;
  readonly #markStarted: () => void;

  public constructor() {
    let markStarted = (): void => undefined;
    let release = (): void => undefined;
    this.promise = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.#markStarted = markStarted;
    this.control = { release, started };
  }

  public markStarted(): void {
    this.#markStarted();
  }
}

class FakeSession implements TaskSdkSession {
  readonly #events = new AsyncQueue<SDKMessage>();
  readonly effortLevels: Array<EffortLevel | null> = [];
  readonly models: Array<string | undefined> = [];
  readonly permissionModes: PermissionMode[] = [];
  readonly submissions: SDKUserMessage[] = [];

  public constructor(
    readonly options: OpenClaudeSdkSessionOptions,
    private readonly supported: ModelInfo[],
    public sessionId: string | undefined,
  ) {}

  public close(): void {
    this.#events.close();
  }

  public emit(message: SDKMessage): void {
    this.#events.push(message);
  }

  public async *events(): AsyncGenerator<SDKMessage> {
    yield* this.#events;
  }

  public async initialize(): Promise<ClaudeSdkInitialization> {
    return {
      initialization: {} as SDKControlInitializeResponse,
      models: this.supported,
    };
  }

  public async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
    return undefined;
  }

  public async setEffortLevel(level: EffortLevel | null): Promise<void> {
    this.effortLevels.push(level);
  }

  public async setModel(model: string | undefined): Promise<void> {
    this.models.push(model);
  }

  public async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionModes.push(mode);
  }

  public submit(message: SDKUserMessage): void {
    this.submissions.push(message);
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  #closed = false;
  #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;

  public close(): void {
    this.#closed = true;
    this.#waiting?.({ done: true, value: undefined });
    this.#waiting = undefined;
  }

  public push(value: T): void {
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ done: false, value });
    } else if (!this.#closed) {
      this.#items.push(value);
    }
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (!this.#closed) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

type Fixture = {
  catalog: FakeCatalog;
  connection: StorageConnection;
  directory: string;
  manager: TaskManager;
  models: ModelInfo[];
  outside: string;
  sessions: FakeSession[];
  workspace: string;
};

function createFixture(fixtures: Fixture[]): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-sessions-"));
  const workspacePath = join(directory, "workspace");
  const outsidePath = join(directory, "outside");
  mkdirSync(workspacePath);
  mkdirSync(outsidePath);
  // Match node:fs/promises realpath, including Windows 8.3 expansion.
  const workspace = realpathSync.native(workspacePath);
  const outside = realpathSync.native(outsidePath);
  const connection = openStorage({
    databasePath: join(directory, "agent.sqlite"),
  });
  connection.sqlite
    .prepare(
      "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(deviceId, "Phone", "public-key", 1);
  const settings = new SettingsRepository(connection.database);
  writeTaskRuntimeSettings(settings, {
    concurrentTaskCapacity: 1,
    workspaceRoots: [workspace],
  });
  const catalog = new FakeCatalog();
  const sessions: FakeSession[] = [];
  const models = [
    {
      description: "Opus",
      displayName: "Opus",
      futureSdkField: true,
      supportedEffortLevels: ["low", "high", "max"],
      supportsEffort: true,
      value: "opus",
    } as ModelInfo,
  ];
  const manager = new TaskManager({
    claudeSessionCatalog: catalog,
    createSession(options) {
      const session = new FakeSession(options, models, options.resume);
      sessions.push(session);
      return session;
    },
    settingsRepository: settings,
    sqlite: connection.database,
  });
  const fixture = {
    catalog,
    connection,
    directory,
    manager,
    models,
    outside,
    sessions,
    workspace,
  };
  fixtures.push(fixture);
  return fixture;
}

function sdkSession(
  sessionId: string,
  cwd?: string,
  extension: Record<string, unknown> = {},
): SDKSessionInfo {
  return {
    lastModified: 1,
    sessionId,
    summary: sessionId,
    ...(cwd === undefined ? {} : { cwd }),
    ...extension,
  };
}

function sdkHistoryMessage(index: number, sessionId: string): SessionMessage {
  return {
    message: { content: `message ${index}` },
    parent_agent_id: null,
    parent_tool_use_id: null,
    session_id: sessionId,
    type: index % 2 === 0 ? "user" : "assistant",
    uuid: `message-${String(index).padStart(3, "0")}`,
  };
}

function sdkInput(content: string): SDKUserMessage {
  return {
    message: { content, role: "user" },
    parent_tool_use_id: null,
    type: "user",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for task state.");
}
