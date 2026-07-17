import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  EffortLevel,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  SDKControlInitializeResponse,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKSessionStateChangedMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { ToolApprovalCancelledError } from "../../src/claude-sdk/permission-gate.js";
import type {
  ClaudeSdkInitialization,
  OpenClaudeSdkSessionOptions,
} from "../../src/claude-sdk/session.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";
import {
  readTaskRuntimeSettings,
  writeTaskCapacitySettings,
  writeTaskRuntimeSettings,
} from "../../src/tasks/settings.js";
import type {
  TaskControlEvent,
  TaskControlEventEnvelope,
  TaskEventSink,
} from "../../src/tasks/task-events.js";
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
    await manager.submitSdkMessage(sdkInput(first.task.id));
    await manager.submitSdkMessage(sdkInput(second.task.id));
    await manager.submitSdkMessage(sdkInput(third.task.id));

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

  it("appends shouldQuery false while idle without inventing a turn", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    const appendOnly = sdkInput(created.task.id, "context only", {
      priority: "later",
      shouldQuery: false,
    });

    const appended = await fixture.manager.submitSdkMessage(appendOnly);
    const session = fixture.sessionFor(created.task.id);

    expect(appended.state).toBe("idle");
    expect(session.submissions).toEqual([appendOnly.message]);
    expect(fixture.eventSink.begunTurns).toEqual([]);

    const querying = sdkInput(created.task.id, "now answer", {
      priority: "next",
    });
    const executing = await fixture.manager.submitSdkMessage(querying);
    expect(executing.state).toBe("executing");
    expect(session.submissions).toEqual([appendOnly.message, querying.message]);
    expect(fixture.eventSink.begunTurns).toEqual([created.task.id]);
  });

  it("cancels a pending approval on interrupt and rejects its stale response", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, {
        model: "haiku",
        workspaceRiskAccepted: true,
      }),
    );
    await fixture.manager.submitSdkMessage(sdkInput(created.task.id));
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
        requestId: "approval-1",
        result: { behavior: "allow" },
      }),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });

    await fixture.manager.submitSdkMessage(
      sdkInput(created.task.id, "continue"),
    );
    expect(session.submissions).toHaveLength(2);
  });

  it("allows model and permission changes during execution for the next turn", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitSdkMessage(sdkInput(created.task.id));
    const session = fixture.sessionFor(created.task.id);

    const model = await fixture.manager.setModel({
      ...operationInput(created.task.id),
      model: "sonnet",
    });
    const permission = await fixture.manager.setPermissionMode({
      ...operationInput(created.task.id),
      permissionMode: "plan",
    });
    expect(permission.task.state).toBe("executing");
    expect(model.task.state).toBe("executing");
    expect(session.permissionModes).toEqual(["plan"]);
    expect(model.task.model).toBe("sonnet");
    expect(session.models).toEqual(["sonnet"]);
  });

  it("marks active work interrupted after a restart and resumes only by saved SDK session ID", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitSdkMessage(sdkInput(created.task.id));
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
      recovered.submitSdkMessage(sdkInput(created.task.id)),
    ).rejects.toMatchObject({ code: "TASK_INTERRUPTED" });

    const resumed = await recovered.resumeTask(operationInput(created.task.id));
    expect(resumed.task.state).toBe("idle");
    expect(recoveredSessions[0]?.options.resume).toBe(
      fixture.manager.getTask(created.task.id).sdkSessionId,
    );
  });

  it("preserves raw SDK scheduling fields and complete approval contracts", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    const first = sdkInput(created.task.id, "first", {
      priority: "next",
      shouldQuery: true,
      timestamp: "2026-07-17T00:00:00.000Z",
      uuid: "00000000-0000-4000-8000-000000000010",
    });

    await fixture.manager.submitSdkMessage(first);
    const session = fixture.sessionFor(created.task.id);
    expect(session.submissions[0]).toBe(first.message);

    const decision = session.requestApproval("approval-full", {
      agentID: "agent-1",
      blockedPath: "README.md",
      decisionReason: "Workspace permission is required.",
      description: "Read access is needed.",
      displayName: "Read file",
      suggestions: [
        {
          behavior: "allow",
          destination: "session",
          rules: [{ ruleContent: "README.md", toolName: "Read" }],
          type: "addRules",
        },
      ],
      title: "Claude wants to read README.md",
    });
    await waitFor(
      () =>
        fixture.manager.getTask(created.task.id).state === "awaiting_approval",
    );

    const later = sdkInput(created.task.id, "later", {
      priority: "now",
      shouldQuery: false,
    });
    await expect(
      fixture.manager.submitSdkMessage(later),
    ).resolves.toMatchObject({ state: "awaiting_approval" });
    expect(session.submissions[1]).toBe(later.message);

    const approvalEvent = fixture.eventSink.controlEvents.find(
      (event) => event.event.kind === "approval.requested",
    );
    expect(approvalEvent?.event.payload).toEqual({
      input: { file_path: "README.md" },
      options: {
        agentID: "agent-1",
        blockedPath: "README.md",
        decisionReason: "Workspace permission is required.",
        description: "Read access is needed.",
        displayName: "Read file",
        requestId: "approval-full",
        suggestions: [
          {
            behavior: "allow",
            destination: "session",
            rules: [{ ruleContent: "README.md", toolName: "Read" }],
            type: "addRules",
          },
        ],
        title: "Claude wants to read README.md",
        toolUseID: "tool-approval-full",
      },
      toolName: "Read",
    });

    const result = {
      behavior: "allow",
      decisionClassification: "user_permanent",
      toolUseID: "tool-approval-full",
      updatedInput: { file_path: "README.md" },
      updatedPermissions: [
        {
          behavior: "allow",
          destination: "session",
          rules: [{ ruleContent: "README.md", toolName: "Read" }],
          type: "addRules",
        },
      ],
    } satisfies PermissionResult;
    await fixture.manager.resolveApproval({
      ...operationInput(created.task.id),
      requestId: "approval-full",
      result,
    });
    await expect(decision).resolves.toBe(result);

    expect(
      fixture.connection.sqlite
        .prepare(
          "SELECT operation, result FROM audit_records WHERE operation = 'task.sdk-message-submitted' ORDER BY occurred_at",
        )
        .all(),
    ).toEqual([
      { operation: "task.sdk-message-submitted", result: "accepted" },
      {
        operation: "task.sdk-message-submitted",
        result: "accepted-without-query",
      },
    ]);
    expect(
      fixture.connection.sqlite
        .prepare("SELECT COUNT(*) AS count FROM operation_results")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("keeps queued SDK queries active until their result boundaries", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitSdkMessage(sdkInput(created.task.id, "first"));
    const session = fixture.sessionFor(created.task.id);
    await fixture.manager.submitSdkMessage(
      sdkInput(created.task.id, "queued", { priority: "next" }),
    );

    session.emitResult();
    await waitFor(() => fixture.eventSink.begunTurns.length === 2);
    expect(fixture.manager.getTask(created.task.id).state).toBe("executing");

    session.emitResult();
    await waitFor(
      () => fixture.manager.getTask(created.task.id).state === "idle",
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
    await fixture.manager.submitSdkMessage(sdkInput(first.task.id));
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

  it("normalizes parent roots and P0-revokes every uncovered task", async () => {
    const closedTaskIds: string[] = [];
    const fixture = createFixture(connections, temporaryDirectories, managers, {
      closeTaskConnections(taskId) {
        closedTaskIds.push(taskId);
      },
    });
    const child = join(fixture.workspace, "child");
    const independent = join(fixture.directory, "independent");
    mkdirSync(child);
    mkdirSync(independent);
    writeTaskRuntimeSettings(fixture.settingsRepository, {
      concurrentTaskCapacity: 3,
      workspaceRoots: [child, independent],
    });
    const created = await fixture.manager.createTask(
      createTaskInput(child, { workspaceRiskAccepted: true }),
    );

    const added = await fixture.manager.addAuthorizedDirectory({
      selectedPath: fixture.workspace,
      volumeRootRiskAccepted: false,
    });
    expect(added).toMatchObject({
      removedRedundantPaths: [child],
      result: "added",
    });
    expect(fixture.manager.getTask(created.task.id).state).toBe("idle");
    expect(
      readTaskRuntimeSettings(fixture.settingsRepository).workspaceRoots,
    ).toEqual([independent, fixture.workspace]);

    const parent = added.snapshot.directories.find(
      (directory) => directory.path === fixture.workspace,
    );
    if (parent === undefined) {
      throw new Error("The normalized parent root is missing.");
    }
    expect(parent.nonTerminalRuntimeCount).toBe(1);
    const removed = await fixture.manager.removeAuthorizedDirectory({
      expectedNonTerminalRuntimeCount: 1,
      path: parent.path,
      revision: added.snapshot.revision,
      runtimeStopAccepted: true,
    });

    expect(removed.stoppedTaskCount).toBe(1);
    expect(fixture.manager.getTask(created.task.id).state).toBe("terminal");
    expect(closedTaskIds).toEqual([created.task.id]);
    expect(
      readTaskRuntimeSettings(fixture.settingsRepository).workspaceRoots,
    ).toEqual([independent]);
    expect(
      fixture.connection.sqlite
        .prepare(
          "SELECT result FROM audit_records WHERE operation = 'workspace.authorization-updated' ORDER BY occurred_at",
        )
        .all()
        .some((row) => JSON.stringify(row).includes(fixture.workspace)),
    ).toBe(false);

    await fixture.manager.addAuthorizedDirectory({
      selectedPath: child,
      volumeRootRiskAccepted: false,
    });
    expect(fixture.manager.getTask(created.task.id).state).toBe("terminal");
  });

  it("preserves a concurrent capacity save while adding a root", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const additionalRoot = join(fixture.directory, "additional");
    mkdirSync(additionalRoot);
    const projectionGate = new Deferred();
    const projectionStarted = new Deferred();
    let resolutionCount = 0;
    const manager = new TaskManager({
      directoryResolver: {
        async canonicalizeDirectory(path) {
          resolutionCount += 1;
          if (resolutionCount > 1) {
            projectionStarted.markStarted();
            await projectionGate.promise;
          }
          return path;
        },
      },
      settingsRepository: fixture.settingsRepository,
      sqlite: fixture.connection.database,
    });
    managers.push(manager);

    const addition = manager.addAuthorizedDirectory({
      selectedPath: additionalRoot,
      volumeRootRiskAccepted: false,
    });
    await projectionStarted.control.started;
    writeTaskCapacitySettings(fixture.settingsRepository, {
      concurrentTaskCapacity: 9,
    });
    projectionGate.control.release();
    await addition;

    expect(readTaskRuntimeSettings(fixture.settingsRepository)).toEqual({
      concurrentTaskCapacity: 9,
      workspaceRoots: [fixture.workspace, additionalRoot],
    });
  });

  it("requires explicit risk acceptance before authorizing a volume root", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const manager = new TaskManager({
      directoryResolver: {
        async canonicalizeDirectory(path) {
          return path;
        },
      },
      settingsRepository: fixture.settingsRepository,
      sqlite: fixture.connection.database,
    });
    managers.push(manager);

    await expect(
      manager.addAuthorizedDirectory({
        selectedPath: "C:\\",
        volumeRootRiskAccepted: false,
      }),
    ).rejects.toMatchObject({ code: "VOLUME_ROOT_RISK_NOT_ACCEPTED" });
  });

  it("invalidates queued P2 controls and persists superseded retries", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitSdkMessage(sdkInput(created.task.id));
    const session = fixture.sessionFor(created.task.id);
    const modelGate = session.deferNextModel();
    const modelInput = {
      ...operationInput(created.task.id),
      model: "opus",
    };
    const permissionInput = {
      ...operationInput(created.task.id),
      permissionMode: "plan",
    };

    const model = fixture.manager.setModel(modelInput);
    await modelGate.started;
    const permission = fixture.manager.setPermissionMode(permissionInput);
    const interrupted = await fixture.manager.interruptTask(
      operationInput(created.task.id),
    );

    expect(interrupted.task.state).toBe("idle");
    await expect(permission).rejects.toMatchObject({
      code: "TASK_OPERATION_SUPERSEDED",
    });
    await expect(
      fixture.manager.setPermissionMode({
        ...operationInput(created.task.id),
        permissionMode: "acceptEdits",
      }),
    ).resolves.toMatchObject({ action: "permission-mode-changed" });
    expect(session.permissionModes).toEqual(["acceptEdits"]);
    modelGate.release();
    await expect(model).rejects.toMatchObject({
      code: "TASK_OPERATION_SUPERSEDED",
    });
    await expect(
      fixture.manager.setPermissionMode(permissionInput),
    ).rejects.toMatchObject({ code: "TASK_OPERATION_SUPERSEDED" });
    expect(session.permissionModes).toEqual(["acceptEdits"]);
  });

  it("lets P0 close win an in-flight P1 interrupt", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitSdkMessage(sdkInput(created.task.id));
    const session = fixture.sessionFor(created.task.id);
    const interruptGate = session.deferNextInterrupt();

    const interrupt = fixture.manager.interruptTask(
      operationInput(created.task.id),
    );
    await interruptGate.started;
    expect(fixture.manager.getTask(created.task.id).state).toBe("interrupted");
    const closed = await fixture.manager.closeTask(
      operationInput(created.task.id),
    );
    interruptGate.release();
    const interrupted = await interrupt;

    expect(closed.task.state).toBe("terminal");
    expect(interrupted.task.state).toBe("terminal");
    expect(fixture.manager.getTask(created.task.id).state).toBe("terminal");
  });
});

class FakeTaskSession implements TaskSdkSession {
  readonly #events = new AsyncEventQueue<SDKMessage>();
  readonly options: OpenClaudeSdkSessionOptions;
  closed = false;
  interruptCalls = 0;
  effortLevels: Array<EffortLevel | null> = [];
  models: Array<string | undefined> = [];
  permissionModes: PermissionMode[] = [];
  readonly submissions: SDKUserMessage[] = [];
  #interruptGate: Deferred | undefined;
  #modelGate: Deferred | undefined;

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

  public async *events(): AsyncGenerator<SDKMessage> {
    yield* this.#events;
  }

  public async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
    this.interruptCalls += 1;
    const gate = this.#interruptGate;
    this.#interruptGate = undefined;
    if (gate !== undefined) {
      gate.markStarted();
      await gate.promise;
    }
    return undefined;
  }

  public async initialize(): Promise<ClaudeSdkInitialization> {
    return {
      initialization: {} as SDKControlInitializeResponse,
      models: [] as ModelInfo[],
    };
  }

  public async setEffortLevel(effortLevel: EffortLevel | null): Promise<void> {
    this.effortLevels.push(effortLevel);
  }

  public async setModel(model: string | undefined): Promise<void> {
    this.models.push(model);
    const gate = this.#modelGate;
    this.#modelGate = undefined;
    if (gate !== undefined) {
      gate.markStarted();
      await gate.promise;
    }
  }

  public async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionModes.push(mode);
  }

  public submit(message: SDKUserMessage): void {
    this.submissions.push(message);
  }

  public deferNextInterrupt(): DeferredControl {
    const gate = new Deferred();
    this.#interruptGate = gate;
    return gate.control;
  }

  public deferNextModel(): DeferredControl {
    const gate = new Deferred();
    this.#modelGate = gate;
    return gate.control;
  }

  public emitState(state: SDKSessionStateChangedMessage["state"]): void {
    this.#events.push({
      session_id: this.sessionId,
      state,
      subtype: "session_state_changed",
      type: "system",
      uuid: randomUUID(),
    });
  }

  public emitResult(): void {
    this.#events.push({
      result: "done",
      session_id: this.sessionId,
      subtype: "success",
      type: "result",
      uuid: randomUUID(),
    } as unknown as SDKMessage);
  }

  public requestApproval(
    approvalId: string,
    options: Partial<
      Omit<
        Parameters<NonNullable<OpenClaudeSdkSessionOptions["canUseTool"]>>[2],
        "requestId" | "signal" | "toolUseID"
      >
    > = {},
  ): Promise<PermissionResult | null> {
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
        ...options,
      },
    );
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
  readonly #release: () => void;

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
    this.#release = release;
    this.control = { release: () => this.#release(), started };
  }

  public markStarted(): void {
    this.#markStarted();
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

class RecordingTaskEventSink implements TaskEventSink {
  readonly begunTurns: string[] = [];
  readonly controlEvents: TaskControlEventEnvelope[] = [];
  readonly sdkMessages: SDKMessage[] = [];
  #nextCursor = 0;

  public beginTurn(taskId: string): void {
    this.begunTurns.push(taskId);
  }

  public endTurn(_taskId: string): void {}

  public publishControlEvent(
    taskId: string,
    event: TaskControlEvent,
  ): TaskControlEventEnvelope {
    const envelope = {
      cursor: this.#nextCursor,
      event,
      occurredAt: 1,
      taskId,
    };
    this.#nextCursor += 1;
    this.controlEvents.push(envelope);
    return envelope;
  }

  public publishSdkMessage(_taskId: string, message: SDKMessage): void {
    this.sdkMessages.push(message);
  }
}

function createFixture(
  connections: StorageConnection[],
  temporaryDirectories: string[],
  managers: TaskManager[],
  closeTaskSdkConnections?: { closeTaskConnections(taskId: string): void },
): {
  connection: StorageConnection;
  directory: string;
  eventSink: RecordingTaskEventSink;
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
  const eventSink = new RecordingTaskEventSink();
  const manager = new TaskManager({
    ...(closeTaskSdkConnections === undefined
      ? {}
      : { closeTaskSdkConnections }),
    createSession: (options) => {
      const session = new FakeTaskSession(options, `sdk-${randomUUID()}`);
      unassignedSessions.push(session);
      return session;
    },
    eventSink,
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
    eventSink,
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

function sdkInput(
  taskId: string,
  content = "hello",
  overrides: Partial<SDKUserMessage> = {},
): {
  deviceId: string;
  message: SDKUserMessage;
  taskId: string;
} {
  return {
    deviceId,
    message: {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      ...overrides,
    },
    taskId,
  };
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
