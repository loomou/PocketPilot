import type {
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { ClaudeProviderAdapter } from "../../src/agent-providers/claude-provider-adapter.js";
import type { TaskEventJournal } from "../../src/tasks/task-event-journal.js";
import type { TaskManager } from "../../src/tasks/task-manager.js";
import type {
  TaskOperationResult,
  TaskSnapshot,
} from "../../src/tasks/task-types.js";

type ClaudeManager = Pick<
  TaskManager,
  | "activateSdkSession"
  | "attachClaudeSession"
  | "createClaudeConversation"
  | "getTask"
  | "listClaudeSessions"
  | "readClaudeSessionHistory"
  | "submitSdkMessage"
>;

describe("ClaudeProviderAdapter", () => {
  it("converts common cursors and preserves native catalog rows", async () => {
    const fixture = createFixture();
    const session = { sessionId: "session-1" } as unknown as SDKSessionInfo;
    const message = {
      type: "assistant",
      uuid: "message-1",
    } as unknown as SessionMessage;
    fixture.listResult = { nextOffset: 12, sessions: [session] };
    fixture.historyResult = {
      messages: [message],
      page: { beforeUuid: "message-1", hasMoreBefore: true },
    };

    const listed = await fixture.adapter.listConversations({
      cursor: "5",
      limit: 7,
      workspace: "C:\\workspace",
    });
    const history = await fixture.adapter.readConversation({
      cursor: "message-2",
      includeSystemMessages: true,
      limit: 20,
      nativeConversationId: "session-1",
      workspace: "C:\\workspace",
    });

    expect(fixture.listInputs).toEqual([
      { limit: 7, offset: 5, workspace: "C:\\workspace" },
    ]);
    expect(listed).toEqual({
      items: [session],
      page: { cursor: "12", hasMore: true },
    });
    expect(listed.items[0]).toBe(session);
    expect(fixture.historyInputs).toEqual([
      {
        beforeUuid: "message-2",
        includeSystemMessages: true,
        limit: 20,
        sessionId: "session-1",
        workspace: "C:\\workspace",
      },
    ]);
    expect(history).toEqual({
      items: [message],
      page: { cursor: "message-1", hasMore: true },
    });
    expect(history.items[0]).toBe(message);
    await expect(
      fixture.adapter.listConversations({
        cursor: "invalid",
        workspace: "C:\\workspace",
      }),
    ).rejects.toThrow("The Claude conversation cursor is invalid.");
  });

  it("delegates create and attach without changing provider-native identity", async () => {
    const fixture = createFixture();
    const createInput = {
      deviceId: "00000000-0000-4000-8000-000000000001",
      operationId: "00000000-0000-4000-8000-000000000002",
      workspace: "C:\\workspace",
      workspaceRiskAccepted: true,
    };
    const attachInput = {
      ...createInput,
      nativeConversationId: "session-1",
      operationId: "00000000-0000-4000-8000-000000000003",
    };

    await fixture.adapter.createConversation(createInput);
    await fixture.adapter.attachConversation(attachInput);

    expect(fixture.createInputs).toEqual([createInput]);
    expect(fixture.attachInputs).toEqual([
      { ...attachInput, sessionId: "session-1" },
    ]);
  });

  it("parses, submits, subscribes, and activates the raw Claude stream", async () => {
    const fixture = createFixture();
    const input = {
      message: { content: "hello", role: "user" },
      parent_tool_use_id: null,
      priority: "now",
      shouldQuery: false,
      type: "user",
      unknown_extension: { preserved: true },
    } as const;
    const parsed = fixture.adapter.taskStream.parseClientFrame(
      JSON.stringify(input),
      false,
    );
    expect(parsed).toEqual(input);
    expect(
      fixture.adapter.taskStream.parseClientFrame(JSON.stringify(input), true),
    ).toBeUndefined();

    await fixture.adapter.taskStream.submit({
      deviceId: "00000000-0000-4000-8000-000000000001",
      message: parsed,
      taskId: task.id,
    });
    expect(fixture.submitInputs).toHaveLength(1);
    expect(fixture.submitInputs[0]?.message).toBe(parsed);

    const received: unknown[] = [];
    const unsubscribe = fixture.adapter.taskStream.subscribe(
      task.id,
      "message-anchor",
      { send: (message) => received.push(message) },
    );
    const output = {
      type: "future_sdk_variant",
      uuid: "output-1",
    } as unknown as SDKMessage;
    fixture.sdkSubscriber?.send(output);
    expect(fixture.subscribeInputs).toEqual([
      { afterUuid: "message-anchor", taskId: task.id },
    ]);
    expect(received).toEqual([output]);
    expect(received[0]).toBe(output);

    await fixture.adapter.taskStream.activate(task.id);
    expect(fixture.activationInputs).toEqual([task.id]);
    unsubscribe();
    expect(fixture.unsubscribed).toBe(true);
  });
});

function createFixture() {
  const activationInputs: string[] = [];
  const attachInputs: Array<
    Parameters<ClaudeManager["attachClaudeSession"]>[0]
  > = [];
  const createInputs: Array<
    Parameters<ClaudeManager["createClaudeConversation"]>[0]
  > = [];
  const historyInputs: Array<
    Parameters<ClaudeManager["readClaudeSessionHistory"]>[0]
  > = [];
  const listInputs: Array<Parameters<ClaudeManager["listClaudeSessions"]>[0]> =
    [];
  const submitInputs: Array<Parameters<ClaudeManager["submitSdkMessage"]>[0]> =
    [];
  const subscribeInputs: Array<{
    afterUuid: string | undefined;
    taskId: string;
  }> = [];
  let historyResult: Awaited<
    ReturnType<ClaudeManager["readClaudeSessionHistory"]>
  > = {
    messages: [],
    page: { beforeUuid: null, hasMoreBefore: false },
  };
  let listResult: Awaited<ReturnType<ClaudeManager["listClaudeSessions"]>> = {
    nextOffset: null,
    sessions: [],
  };
  let sdkSubscriber:
    | Parameters<TaskEventJournal["subscribeSdk"]>[2]
    | undefined;
  let unsubscribed = false;

  const manager: ClaudeManager = {
    async activateSdkSession(taskId): Promise<void> {
      activationInputs.push(taskId);
    },
    async attachClaudeSession(input): Promise<TaskOperationResult> {
      attachInputs.push(input);
      return { action: "attached", task };
    },
    async createClaudeConversation(input): Promise<TaskOperationResult> {
      createInputs.push(input);
      return { action: "created", task };
    },
    getTask(): TaskSnapshot {
      return task;
    },
    async listClaudeSessions(input) {
      listInputs.push(input);
      return listResult;
    },
    async readClaudeSessionHistory(input) {
      historyInputs.push(input);
      return historyResult;
    },
    async submitSdkMessage(input): Promise<TaskSnapshot> {
      submitInputs.push(input);
      return task;
    },
  };
  const journal: Pick<TaskEventJournal, "subscribeSdk"> = {
    subscribeSdk(taskId, afterUuid, subscriber): () => void {
      subscribeInputs.push({ afterUuid, taskId });
      sdkSubscriber = subscriber;
      return () => {
        unsubscribed = true;
      };
    },
  };
  const adapter = new ClaudeProviderAdapter(manager, journal);

  return {
    activationInputs,
    adapter,
    attachInputs,
    createInputs,
    historyInputs,
    set historyResult(value: typeof historyResult) {
      historyResult = value;
    },
    listInputs,
    set listResult(value: typeof listResult) {
      listResult = value;
    },
    get sdkSubscriber() {
      return sdkSubscriber;
    },
    submitInputs,
    subscribeInputs,
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

const task: TaskSnapshot = {
  createdAt: 1,
  id: "00000000-0000-4000-8000-000000000004",
  initialCwd: "C:\\workspace",
  interruptedAt: null,
  model: null,
  nativeProtocolVersion: "@anthropic-ai/claude-agent-sdk@0.3.210",
  origin: "claude-session",
  permissionMode: null,
  provider: "claude",
  sdkSessionId: "session-1",
  state: "idle",
  terminalAt: null,
  updatedAt: 1,
};
