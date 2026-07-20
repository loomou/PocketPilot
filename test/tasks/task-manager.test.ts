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
  createPocketPilotLogger,
  type PocketPilotLogger,
} from "../../src/logging/logger.js";
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
import { TaskRepository } from "../../src/tasks/task-repository.js";

const deviceId = "00000000-0000-4000-8000-000000000001";

function requireTaskResult(result: {
  action: string;
  task: import("../../src/tasks/task-types.js").TaskSnapshot | null;
}): import("../../src/tasks/task-types.js").TaskSnapshot {
  if (result.task === null) {
    throw new Error(`expected task for action ${result.action}`);
  }
  return result.task;
}

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

    expect(requireTaskResult(first).state).toBe("idle");
    expect(requireTaskResult(second).initialCwd).toBe(
      requireTaskResult(first).initialCwd,
    );
    await manager.submitSdkMessage(sdkInput(requireTaskResult(first).id));
    await manager.submitSdkMessage(sdkInput(requireTaskResult(second).id));
    await manager.submitSdkMessage(sdkInput(requireTaskResult(third).id));

    await expect(
      manager.createTask(
        createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
      ),
    ).rejects.toMatchObject({ code: "CONCURRENT_TASK_LIMIT_REACHED" });

    fixture.sessionFor(requireTaskResult(first).id).emitState("idle");
    await waitFor(
      () => manager.getTask(requireTaskResult(first).id).state === "idle",
    );

    const fourth = await manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    expect(requireTaskResult(fourth).initialCwd).toBe(
      requireTaskResult(first).initialCwd,
    );
  });

  it("applies shared capacity and lifecycle events to provider-native turns", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    writeTaskCapacitySettings(fixture.settingsRepository, {
      concurrentTaskCapacity: 1,
    });
    const first = createCodexTask(fixture.connection, fixture.workspace);
    const second = createCodexTask(fixture.connection, fixture.workspace);
    const runtime = fixture.manager.providerTaskRuntime();

    await runtime.run(first.id, (lease) =>
      runtime.reserveTurn(first.id, lease),
    );
    await expect(
      runtime.run(second.id, (lease) => runtime.reserveTurn(second.id, lease)),
    ).rejects.toMatchObject({ code: "CONCURRENT_TASK_LIMIT_REACHED" });
    runtime.turnStarted(first.id, "turn-1");
    runtime.approvalRequested(first.id, {
      method: "item/fileChange/requestApproval",
      params: { itemId: "item-1", turnId: "turn-1" },
      provider: "codex",
      requestId: 7,
    });

    expect(fixture.manager.getTask(first.id)).toMatchObject({
      activeTurnId: "turn-1",
      state: "awaiting_approval",
    });
    expect(fixture.eventSink.controlEvents).toContainEqual(
      expect.objectContaining({
        event: {
          kind: "approval.requested",
          payload: {
            method: "item/fileChange/requestApproval",
            params: { itemId: "item-1", turnId: "turn-1" },
            provider: "codex",
            requestId: 7,
          },
        },
        taskId: first.id,
      }),
    );

    runtime.approvalResolved(first.id, 0);
    expect(fixture.manager.getTask(first.id).state).toBe("executing");
    runtime.turnCompleted(first.id);
    expect(fixture.manager.getTask(first.id)).toMatchObject({
      activeTurnId: null,
      state: "idle",
    });
  });

  it("terminalizes and closes provider-native tasks when their root is revoked", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const task = createCodexTask(fixture.connection, fixture.workspace);
    const closedTaskIds: string[] = [];
    fixture.manager.setProviderTaskController({
      close: async (taskId) => {
        closedTaskIds.push(taskId);
      },
      interrupt: async () => undefined,
      resume: async () => undefined,
    });
    const snapshot = await fixture.manager.authorizedDirectorySnapshot();
    const root = snapshot.directories.find(
      (directory) => directory.path === fixture.workspace,
    );
    if (root === undefined) {
      throw new Error("The provider test workspace root is missing.");
    }

    const removed = await fixture.manager.removeAuthorizedDirectory({
      expectedNonTerminalRuntimeCount: 1,
      path: root.path,
      revision: snapshot.revision,
      runtimeStopAccepted: true,
    });

    expect(removed.stoppedTaskCount).toBe(1);
    expect(fixture.manager.getTask(task.id).state).toBe("terminal");
    expect(closedTaskIds).toEqual([task.id]);
  });

  it("invalidates active and queued provider work when P1 interrupt starts", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const task = createCodexTask(fixture.connection, fixture.workspace);
    const runtime = fixture.manager.providerTaskRuntime();
    let markStarted = (): void => {};
    let release = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = runtime.run(task.id, async (lease) => {
      markStarted();
      await blocker;
      lease.assertCurrent();
      return "active";
    });
    await started;
    const queued = runtime.run(task.id, () => "queued");
    const activeResult = expect(active).rejects.toMatchObject({
      code: "TASK_OPERATION_SUPERSEDED",
    });
    const queuedResult = expect(queued).rejects.toMatchObject({
      code: "TASK_OPERATION_SUPERSEDED",
    });

    runtime.beginInterrupt(task.id);
    release();
    await Promise.all([activeResult, queuedResult]);
    expect(fixture.manager.getTask(task.id).state).toBe("interrupted");
    await expect(
      Promise.resolve().then(() => runtime.run(task.id, () => "stale")),
    ).rejects.toMatchObject({ code: "TASK_INTERRUPTED" });
    runtime.completeInterrupt(task.id);
    expect(fixture.manager.getTask(task.id).state).toBe("idle");
  });

  it("rejects Claude-only controls for a Codex task", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const task = createCodexTask(fixture.connection, fixture.workspace);

    await expect(
      fixture.manager.getComposerOptions(task.id),
    ).rejects.toMatchObject({ code: "TASK_CONTROL_NOT_SUPPORTED" });
    await expect(
      fixture.manager.setModel({
        deviceId,
        model: "gpt-test",
        operationId: randomUUID(),
        taskId: task.id,
      }),
    ).rejects.toMatchObject({ code: "TASK_CONTROL_NOT_SUPPORTED" });
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
    const appendOnly = sdkInput(requireTaskResult(created).id, "context only", {
      priority: "later",
      shouldQuery: false,
    });

    const appended = await fixture.manager.submitSdkMessage(appendOnly);
    const session = fixture.sessionFor(requireTaskResult(created).id);

    expect(appended.state).toBe("idle");
    expect(session.submissions).toEqual([appendOnly.message]);
    expect(fixture.eventSink.begunTurns).toEqual([]);

    const querying = sdkInput(requireTaskResult(created).id, "now answer", {
      priority: "next",
    });
    const executing = await fixture.manager.submitSdkMessage(querying);
    expect(executing.state).toBe("executing");
    expect(session.submissions).toEqual([appendOnly.message, querying.message]);
    expect(fixture.eventSink.begunTurns).toEqual([
      requireTaskResult(created).id,
    ]);
  });

  it("logs task and SDK lifecycle without conversation or configuration content", async () => {
    const logs = createCapture();
    const logger = createPocketPilotLogger({
      color: false,
      destination: logs,
      level: "debug",
    });
    const fixture = createFixture(
      connections,
      temporaryDirectories,
      managers,
      undefined,
      logger,
    );
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, {
        model: "sensitive-model-name",
        workspaceRiskAccepted: true,
      }),
    );
    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(created).id, "sensitive user prompt"),
    );
    const session = fixture.sessionFor(requireTaskResult(created).id);
    const decision = session.requestApproval("approval-observable");
    await waitFor(
      () =>
        fixture.manager.getTask(requireTaskResult(created).id).state ===
        "awaiting_approval",
    );
    await fixture.manager.resolveApproval({
      ...operationInput(requireTaskResult(created).id),
      requestId: "approval-observable",
      result: { behavior: "allow" },
    });
    await expect(decision).resolves.toMatchObject({ behavior: "allow" });
    session.emitResult();
    await waitFor(
      () =>
        fixture.manager.getTask(requireTaskResult(created).id).state === "idle",
    );

    const output = logs.value();
    for (const expected of [
      "Task created",
      "SDK user message accepted",
      "SDK Query started",
      "Task approval requested",
      "Task approval resolved",
      "SDK Query completed",
      "Task state changed",
    ]) {
      expect(output).toContain(expected);
    }
    for (const forbidden of [
      "sensitive-model-name",
      "sensitive user prompt",
      "README.md",
      "file_path",
      'result="done"',
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  it("cancels a pending approval on interrupt and rejects its stale response", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, {
        model: "haiku",
        workspaceRiskAccepted: true,
      }),
    );
    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(created).id),
    );
    const session = fixture.sessionFor(requireTaskResult(created).id);

    expect(session.options.model).toBe("haiku");
    expect(session.options.permissionMode).toBe("default");
    const decision = session.requestApproval("approval-1");

    await waitFor(
      () =>
        fixture.manager.getTask(requireTaskResult(created).id).state ===
        "awaiting_approval",
    );
    const interrupted = await fixture.manager.interruptTask(
      operationInput(requireTaskResult(created).id),
    );

    expect(requireTaskResult(interrupted).state).toBe("idle");
    await expect(decision).rejects.toBeInstanceOf(ToolApprovalCancelledError);
    await expect(
      fixture.manager.resolveApproval({
        ...operationInput(requireTaskResult(created).id),
        requestId: "approval-1",
        result: { behavior: "allow" },
      }),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });

    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(created).id, "continue"),
    );
    expect(session.submissions).toHaveLength(2);
  });

  it("allows model and permission changes during execution for the next turn", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(created).id),
    );
    const session = fixture.sessionFor(requireTaskResult(created).id);

    const model = await fixture.manager.setModel({
      ...operationInput(requireTaskResult(created).id),
      model: "sonnet",
    });
    const permission = await fixture.manager.setPermissionMode({
      ...operationInput(requireTaskResult(created).id),
      permissionMode: "plan",
    });
    expect(requireTaskResult(permission).state).toBe("executing");
    expect(requireTaskResult(model).state).toBe("executing");
    expect(session.permissionModes).toEqual(["plan"]);
    expect(requireTaskResult(model).model).toBe("sonnet");
    expect(session.models).toEqual(["sonnet"]);
  });

  it("marks active work interrupted after a restart and resumes only by saved SDK session ID", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(created).id),
    );
    fixture.sessionFor(requireTaskResult(created).id).emitState("running");
    await waitFor(
      () =>
        fixture.manager.getTask(requireTaskResult(created).id).sdkSessionId !==
        null,
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
    expect(recovered.getTask(requireTaskResult(created).id).state).toBe(
      "interrupted",
    );
    await expect(
      recovered.submitSdkMessage(sdkInput(requireTaskResult(created).id)),
    ).rejects.toMatchObject({ code: "TASK_INTERRUPTED" });

    const resumed = await recovered.resumeTask(
      operationInput(requireTaskResult(created).id),
    );
    expect(requireTaskResult(resumed).state).toBe("idle");
    expect(recoveredSessions[0]?.options.resume).toBe(
      fixture.manager.getTask(requireTaskResult(created).id).sdkSessionId,
    );
  });

  it("preserves raw SDK scheduling fields and complete approval contracts", async () => {
    const fixture = createFixture(connections, temporaryDirectories, managers);
    const created = await fixture.manager.createTask(
      createTaskInput(fixture.workspace, { workspaceRiskAccepted: true }),
    );
    const first = sdkInput(requireTaskResult(created).id, "first", {
      priority: "next",
      shouldQuery: true,
      timestamp: "2026-07-17T00:00:00.000Z",
      uuid: "00000000-0000-4000-8000-000000000010",
    });

    await fixture.manager.submitSdkMessage(first);
    const session = fixture.sessionFor(requireTaskResult(created).id);
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
        fixture.manager.getTask(requireTaskResult(created).id).state ===
        "awaiting_approval",
    );

    const later = sdkInput(requireTaskResult(created).id, "later", {
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
      ...operationInput(requireTaskResult(created).id),
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
    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(created).id, "first"),
    );
    const session = fixture.sessionFor(requireTaskResult(created).id);
    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(created).id, "queued", { priority: "next" }),
    );

    session.emitResult();
    await waitFor(() => fixture.eventSink.begunTurns.length === 2);
    expect(fixture.manager.getTask(requireTaskResult(created).id).state).toBe(
      "executing",
    );

    session.emitResult();
    await waitFor(
      () =>
        fixture.manager.getTask(requireTaskResult(created).id).state === "idle",
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
    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(first).id),
    );
    const session = fixture.sessionFor(requireTaskResult(first).id);

    const closed = await fixture.manager.closeTask(
      operationInput(requireTaskResult(first).id),
    );
    expect(requireTaskResult(closed).state).toBe("terminal");
    expect(session.interruptCalls).toBe(1);
    expect(session.closed).toBe(true);

    await fixture.manager.shutdown();
    expect(fixture.manager.getTask(requireTaskResult(second).id).state).toBe(
      "terminal",
    );
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
    expect(fixture.manager.getTask(requireTaskResult(created).id).state).toBe(
      "idle",
    );
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
    expect(fixture.manager.getTask(requireTaskResult(created).id).state).toBe(
      "terminal",
    );
    expect(closedTaskIds).toEqual([requireTaskResult(created).id]);
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
    expect(fixture.manager.getTask(requireTaskResult(created).id).state).toBe(
      "terminal",
    );
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
    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(created).id),
    );
    const session = fixture.sessionFor(requireTaskResult(created).id);
    const modelGate = session.deferNextModel();
    const modelInput = {
      ...operationInput(requireTaskResult(created).id),
      model: "opus",
    };
    const permissionInput = {
      ...operationInput(requireTaskResult(created).id),
      permissionMode: "plan",
    };

    const model = fixture.manager.setModel(modelInput);
    await modelGate.started;
    const permission = fixture.manager.setPermissionMode(permissionInput);
    const interrupted = await fixture.manager.interruptTask(
      operationInput(requireTaskResult(created).id),
    );

    expect(requireTaskResult(interrupted).state).toBe("idle");
    await expect(permission).rejects.toMatchObject({
      code: "TASK_OPERATION_SUPERSEDED",
    });
    await expect(
      fixture.manager.setPermissionMode({
        ...operationInput(requireTaskResult(created).id),
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
    await fixture.manager.submitSdkMessage(
      sdkInput(requireTaskResult(created).id),
    );
    const session = fixture.sessionFor(requireTaskResult(created).id);
    const interruptGate = session.deferNextInterrupt();

    const interrupt = fixture.manager.interruptTask(
      operationInput(requireTaskResult(created).id),
    );
    await interruptGate.started;
    expect(fixture.manager.getTask(requireTaskResult(created).id).state).toBe(
      "interrupted",
    );
    const closed = await fixture.manager.closeTask(
      operationInput(requireTaskResult(created).id),
    );
    interruptGate.release();
    const interrupted = await interrupt;

    expect(requireTaskResult(closed).state).toBe("terminal");
    expect(requireTaskResult(interrupted).state).toBe("terminal");
    expect(fixture.manager.getTask(requireTaskResult(created).id).state).toBe(
      "terminal",
    );
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
  closeTaskAgentConnections?: { closeTaskConnections(taskId: string): void },
  logger?: PocketPilotLogger,
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
    ...(closeTaskAgentConnections === undefined
      ? {}
      : { closeTaskAgentConnections }),
    createSession: (options) => {
      const session = new FakeTaskSession(options, `sdk-${randomUUID()}`);
      unassignedSessions.push(session);
      return session;
    },
    eventSink,
    ...(logger === undefined ? {} : { logger }),
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

function createCodexTask(connection: StorageConnection, workspace: string) {
  return new TaskRepository(connection.database).create({
    createdAt: Date.now(),
    id: randomUUID(),
    initialCwd: workspace,
    model: null,
    nativeConversationId: `thread-${randomUUID()}`,
    nativeProtocolVersion: "codex-app-server@0.144.x",
    nativeSessionId: `session-${randomUUID()}`,
    origin: "agent-conversation",
    permissionMode: null,
    provider: "codex",
  });
}

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
