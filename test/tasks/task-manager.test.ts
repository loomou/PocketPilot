import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PermissionMode,
  PermissionResult,
  SDKControlInterruptResponse,
  SDKSessionStateChangedMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedClaudeSdkEvent } from "../../src/claude-sdk/event-normalizer.js";
import { ToolApprovalCancelledError } from "../../src/claude-sdk/permission-gate.js";
import type { OpenClaudeSdkSessionOptions } from "../../src/claude-sdk/session.js";
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

describe("TaskManager", () => {
  const connections: StorageConnection[] = [];
  const managers: TaskManager[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("enforces risk acknowledgement, authorized roots, and active-task capacity", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const manager = fixture.manager;

    await expect(
      manager.createTask(createTaskInput(fixture.workspace)),
    ).rejects.toMatchObject({ code: "WORKSPACE_SCOPE_RISK_NOT_ACCEPTED" });
    expect(manager.listTasks()).toHaveLength(0);

    await expect(
      manager.createTask(
        createTaskInput(join(fixture.directory, "outside"), {
          workspaceRiskAccepted: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_AUTHORIZED" });
    await expect(
      manager.createTask(
        createTaskInput(fixture.workspace, {
          permissionMode: "unsupported-mode",
          workspaceRiskAccepted: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PERMISSION_MODE" });

    const first = await manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    const second = await manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    const third = await manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );

    expect(first.task.state).toBe("idle");
    expect(second.task.initialCwd).toBe(first.task.initialCwd);
    await manager.submitInstruction(instructionInput(first.task.id));
    await manager.submitInstruction(instructionInput(second.task.id));
    await manager.submitInstruction(instructionInput(third.task.id));

    await expect(
      manager.createTask(
        createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
      ),
    ).rejects.toMatchObject({ code: "CONCURRENT_TASK_LIMIT_REACHED" });

    fixture.sessionFor(first.task.id).emitState("idle");
    await waitFor(() => manager.getTask(first.task.id).state === "idle");

    const fourth = await manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    expect(fourth.task.initialCwd).toBe(first.task.initialCwd);
  });

  it("deduplicates a state-changing operation and writes one metadata-only audit", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const input = createTaskInput(fixture.workspace, {
      operationId: "00000000-0000-4000-8000-000000000002",
      workspaceRiskAccepted: true,
    });

    const first = await fixture.manager.createTask(input);
    const retry = await fixture.manager.createTask(input);

    expect(retry).toEqual(first);
    expect(fixture.manager.listTasks()).toHaveLength(1);
    expect(
      fixture.connection.sqlite
        .prepare("SELECT operation, result FROM audit_records")
        .all(),
    ).toEqual([
      {
        operation: "task.created",
        result: "workspace-risk-accepted",
      },
    ]);
    expect(
      fixture.connection.sqlite
        .prepare("SELECT result_json AS resultJson FROM operation_results")
        .all(),
    ).toEqual([{ resultJson: JSON.stringify(first) }]);
  });

  it("cancels a pending approval on interrupt and rejects its stale response", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, {
        model: "haiku",
        workspaceRiskAccepted: true,
      }),
    );
    await fixture.manager.submitInstruction(instructionInput(created.task.id));
    const session = fixture.sessionFor(created.task.id);

    expect(session.options.model).toBe("haiku");
    expect(session.options.permissionMode).toBe("default");
    const decision = session.requestApproval("approval-1");

    await waitFor(
      () =>
        fixture.manager.getTask(created.task.id).state === "awaiting_approval",
    );
    const interrupted = await fixture.manager.interruptTask(
      operationInput(created.task.id),
    );

    expect(interrupted.task.state).toBe("idle");
    await expect(decision).rejects.toBeInstanceOf(ToolApprovalCancelledError);
    await expect(
      fixture.manager.resolveApproval({
        ...operationInput(created.task.id),
        approvalId: "approval-1",
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });

    await fixture.manager.submitInstruction(
      instructionInput(created.task.id, "continue"),
    );
    expect(session.submissions).toHaveLength(2);
  });

  it("allows permission changes during execution but defers model changes until idle", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitInstruction(instructionInput(created.task.id));
    const session = fixture.sessionFor(created.task.id);

    await expect(
      fixture.manager.setModel({
        ...operationInput(created.task.id),
        model: "sonnet",
      }),
    ).rejects.toMatchObject({ code: "TASK_BUSY" });
    const permission = await fixture.manager.setPermissionMode({
      ...operationInput(created.task.id),
      permissionMode: "plan",
    });
    expect(permission.task.state).toBe("executing");
    expect(session.permissionModes).toEqual(["plan"]);

    session.emitState("idle");
    await waitFor(
      () => fixture.manager.getTask(created.task.id).state === "idle",
    );
    const model = await fixture.manager.setModel({
      ...operationInput(created.task.id),
      model: "sonnet",
    });

    expect(model.task.model).toBe("sonnet");
    expect(session.models).toEqual(["sonnet"]);
  });

  it("marks active work interrupted after a restart and resumes only by saved SDK session ID", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitInstruction(instructionInput(created.task.id));
    fixture.sessionFor(created.task.id).emitState("running");
    await waitFor(
      () => fixture.manager.getTask(created.task.id).sdkSessionId !== null,
    );

    const recoveredSessions: FakeTaskSession[] = [];
    const recovered = new TaskManager({
      createSession: (options) => {
        const session = new FakeTaskSession(
          options,
          `recovered-${randomUUID()}`,
        );
        recoveredSessions.push(session);
        return session;
      },
      settingsRepository: fixture.settingsRepository,
      sqlite: fixture.connection.database,
    });
    managers.push(recovered);

    expect(recovered.recoverFromUnexpectedRestart()).toBe(1);
    expect(recovered.getTask(created.task.id).state).toBe("interrupted");
    await expect(
      recovered.submitInstruction(instructionInput(created.task.id)),
    ).rejects.toMatchObject({ code: "TASK_INTERRUPTED" });

    const resumed = await recovered.resumeTask(operationInput(created.task.id));
    expect(resumed.task.state).toBe("idle");
    expect(recoveredSessions[0]?.options.resume).toBe(
      fixture.manager.getTask(created.task.id).sdkSessionId,
    );
  });

  it("close and manual shutdown make every non-terminal task non-resumable", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const first = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    const second = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitInstruction(instructionInput(first.task.id));
    const session = fixture.sessionFor(first.task.id);

    const closed = await fixture.manager.closeTask(
      operationInput(first.task.id),
    );
    expect(closed.task.state).toBe("terminal");
    expect(session.interruptCalls).toBe(1);
    expect(session.closed).toBe(true);

    await fixture.manager.shutdown();
    expect(fixture.manager.getTask(second.task.id).state).toBe("terminal");
  });
});

class FakeTaskSession implements TaskSdkSession {
  readonly #events = new AsyncEventQueue<NormalizedClaudeSdkEvent>();
  readonly options: OpenClaudeSdkSessionOptions;
  closed = false;
  interruptCalls = 0;
  models: Array<string | undefined> = [];
  permissionModes: PermissionMode[] = [];
  readonly submissions: SDKUserMessage[] = [];

  public constructor(
    options: OpenClaudeSdkSessionOptions,
    public sessionId: string,
  ) {
    this.options = options;
  }

  public close(): void {
    this.closed = true;
    this.#events.close();
  }

  public async *events(): AsyncGenerator<NormalizedClaudeSdkEvent> {
    yield* this.#events;
  }

  public async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
    this.interruptCalls += 1;
    return undefined;
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

  public emitState(state: SDKSessionStateChangedMessage["state"]): void {
    this.#events.push({
      kind: "session.state-changed",
      message: {
        session_id: this.sessionId,
        state,
        subtype: "session_state_changed",
        type: "system",
        uuid: randomUUID(),
      },
    });
  }

  public requestApproval(approvalId: string): Promise<PermissionResult | null> {
    const canUseTool = this.options.canUseTool;
    if (canUseTool === undefined) {
      throw new Error(
        "Task session was opened without a tool approval handler.",
      );
    }
    const controller = new AbortController();
    return canUseTool(
      "Read",
      { file_path: "README.md" },
      {
        requestId: approvalId,
        signal: controller.signal,
        toolUseID: `tool-${approvalId}`,
      },
    );
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  #closed = false;
  #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;

  public close(): void {
    this.#closed = true;
    this.#waiting?.({ done: true, value: undefined });
    this.#waiting = undefined;
  }

  public push(value: T): void {
    if (this.#closed) {
      return;
    }
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ done: false, value });
      return;
    }
    this.#items.push(value);
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#closed) {
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolveNext) => {
        this.#waiting = resolveNext;
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}

function createFixture(
  connections: StorageConnection[],
  temporaryDirectories: string[],
  managers: TaskManager[],
): {
  connection: StorageConnection;
  directory: string;
  manager: TaskManager;
  sessionFor(taskId: string): FakeTaskSession;
  settingsRepository: SettingsRepository;
  workspace: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-task-"));
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const connection = openStorage({
    databasePath: join(directory, "agent.sqlite"),
  });
  connection.sqlite
    .prepare(
      "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(deviceId, "Test device", "public-key", 1);
  const settingsRepository = new SettingsRepository(connection.database);
  writeTaskRuntimeSettings(settingsRepository, {
    concurrentTaskCapacity: 3,
    workspaceRoots: [workspace],
  });
  const sessionsByTask = new Map<string, FakeTaskSession>();
  const unassignedSessions: FakeTaskSession[] = [];
  const manager = new TaskManager({
    createSession: (options) => {
      const session = new FakeTaskSession(options, `sdk-${randomUUID()}`);
      unassignedSessions.push(session);
      return session;
    },
    settingsRepository,
    sqlite: connection.database,
  });

  const sessionFor = (taskId: string): FakeTaskSession => {
    const existing = sessionsByTask.get(taskId);
    if (existing !== undefined) {
      return existing;
    }
    const session = unassignedSessions.shift();
    if (session === undefined) {
      throw new Error(`No fake SDK session exists for task '${taskId}'.`);
    }
    sessionsByTask.set(taskId, session);
    return session;
  };

  connections.push(connection);
  temporaryDirectories.push(directory);
  managers.push(manager);
  return {
    connection,
    directory,
    manager,
    sessionFor,
    settingsRepository,
    workspace,
  };
}

function createTaskInput(
  initialCwd: string,
  overrides: Partial<{
    model: string;
    operationId: string;
    permissionMode: string;
    workspaceRiskAccepted: boolean;
  }> = {},
): {
  deviceId: string;
  initialCwd: string;
  model?: string;
  operationId: string;
  permissionMode: string;
  workspaceRiskAccepted: boolean;
} {
  return {
    deviceId,
    initialCwd,
    operationId: overrides.operationId ?? randomUUID(),
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    permissionMode: overrides.permissionMode ?? "default",
    workspaceRiskAccepted: overrides.workspaceRiskAccepted ?? false,
  };
}

function instructionInput(
  taskId: string,
  instruction = "hello",
): {
  deviceId: string;
  instruction: string;
  operationId: string;
  taskId: string;
} {
  return { ...operationInput(taskId), instruction };
}

function operationInput(taskId: string): {
  deviceId: string;
  operationId: string;
  taskId: string;
} {
  return { deviceId, operationId: randomUUID(), taskId };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolveNext) => setImmediate(resolveNext));
  }
  throw new Error("Timed out while waiting for task runtime state.");
}
