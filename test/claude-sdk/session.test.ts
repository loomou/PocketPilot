import type {
  EffortLevel,
  ModelInfo,
  PermissionMode,
  SDKControlInitializeResponse,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKSessionStateChangedMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  type ClaudeSdkQuery,
  openClaudeSdkSession,
  pinnedPermissionModes,
} from "../../src/claude-sdk/session.js";
import { collectAsync } from "../helpers/collect-async.js";

const stateChangeMessage = {
  type: "system",
  subtype: "session_state_changed",
  state: "idle",
  uuid: "00000000-0000-0000-0000-000000000001",
  session_id: "session-1",
} satisfies SDKSessionStateChangedMessage;

function createFakeQuery(
  messages: SDKMessage[] = [stateChangeMessage],
): ClaudeSdkQuery & {
  readonly calls: string[];
} {
  const calls: string[] = [];

  return {
    calls,
    async applyFlagSettings(settings): Promise<void> {
      calls.push(
        `effort:${String((settings as { effortLevel?: EffortLevel | null }).effortLevel)}`,
      );
    },
    async initializationResult(): Promise<SDKControlInitializeResponse> {
      throw new Error(
        "Initialization is exercised by the opt-in live SDK test.",
      );
    },
    async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
      calls.push("interrupt");
      return undefined;
    },
    close(): void {
      calls.push("close");
    },
    async setModel(model: string | undefined): Promise<void> {
      calls.push(`model:${model ?? "default"}`);
    },
    async setPermissionMode(mode: PermissionMode): Promise<void> {
      calls.push(`permission:${mode}`);
    },
    async supportedModels(): Promise<ModelInfo[]> {
      return [];
    },
    async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
      yield* messages;
    },
  };
}

describe("Claude SDK session adapter", () => {
  it("forwards controls and keeps later instructions on one long-lived input stream", async () => {
    const fakeQuery = createFakeQuery();
    let sdkInput: AsyncIterable<SDKUserMessage> | undefined;
    const session = openClaudeSdkSession(
      {
        cwd: process.cwd(),
      },
      (params) => {
        sdkInput = params.prompt;
        return fakeQuery;
      },
    );

    session.submit(sdkUserMessage("later instruction"));
    await session.setModel("sonnet");
    await session.setPermissionMode("plan");
    await session.setEffortLevel("max");
    await session.setEffortLevel(null);
    await session.interrupt();
    session.close();

    if (sdkInput === undefined) {
      throw new Error("The SDK query factory did not receive an input stream.");
    }

    await expect(collectAsync(sdkInput)).resolves.toEqual([
      {
        type: "user",
        message: { role: "user", content: "later instruction" },
        parent_tool_use_id: null,
        origin: { kind: "human" },
      },
    ]);
    expect(fakeQuery.calls).toEqual([
      "model:sonnet",
      "permission:plan",
      "effort:max",
      "effort:null",
      "interrupt",
      "close",
    ]);
  });

  it("yields every SDK message unchanged", async () => {
    const userMessage = {
      type: "user",
      message: { role: "user", content: "raw SDK input echo" },
      parent_tool_use_id: null,
      priority: "next",
      shouldQuery: false,
      future_transport_field: { preserved: true },
    } as SDKMessage;
    const assistantMessage = {
      type: "assistant",
      message: { content: [], role: "assistant" },
      parent_tool_use_id: null,
      session_id: "session-1",
      uuid: "00000000-0000-0000-0000-000000000002",
    } as unknown as SDKMessage;
    const streamMessage = {
      type: "stream_event",
      event: { type: "content_block_delta" },
      parent_tool_use_id: null,
      session_id: "session-1",
      uuid: "00000000-0000-0000-0000-000000000003",
    } as unknown as SDKMessage;
    const toolProgressMessage = {
      type: "tool_progress",
      elapsed_time_seconds: 1,
      parent_tool_use_id: null,
      session_id: "session-1",
      tool_name: "Read",
      tool_use_id: "tool-1",
      uuid: "00000000-0000-0000-0000-000000000004",
    } as SDKMessage;
    const resultMessage = {
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "session-1",
      uuid: "00000000-0000-0000-0000-000000000005",
    } as unknown as SDKMessage;
    const openSdkVariant = {
      type: "system",
      subtype: "status",
      status: "requesting",
      session_id: "session-1",
      uuid: "00000000-0000-0000-0000-000000000006",
      future_status_field: true,
    } as unknown as SDKMessage;
    const messages = [
      userMessage,
      assistantMessage,
      streamMessage,
      stateChangeMessage,
      toolProgressMessage,
      resultMessage,
      openSdkVariant,
      userMessage,
    ];
    const session = openClaudeSdkSession(
      {
        cwd: process.cwd(),
      },
      () => createFakeQuery(messages),
    );

    const received = await collectAsync(session.events());
    expect(received).toEqual(messages);
    expect(
      received.every((message, index) => message === messages[index]),
    ).toBe(true);
    expect(session.sessionId).toBe("session-1");
  });

  it("lists every permission mode in the pinned SDK contract", () => {
    expect(pinnedPermissionModes).toEqual([
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
      "auto",
    ]);
  });

  it("forwards a persisted SDK session ID through Options.resume", () => {
    const fakeQuery = createFakeQuery();
    let environment: NodeJS.ProcessEnv | undefined;
    let resume: string | undefined;

    openClaudeSdkSession(
      {
        cwd: process.cwd(),
        resume: "00000000-0000-0000-0000-000000000002",
      },
      (params) => {
        environment = params.options?.env;
        resume = params.options?.resume;
        return fakeQuery;
      },
    );

    expect(resume).toBe("00000000-0000-0000-0000-000000000002");
    expect(environment).toBeUndefined();
  });

  it("labels a new conversation with a copied PocketPilot child environment", () => {
    const parentEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    let environment: NodeJS.ProcessEnv | undefined;

    openClaudeSdkSession({ cwd: process.cwd() }, (params) => {
      environment = params.options?.env;
      return createFakeQuery();
    });

    expect(environment).toBeDefined();
    expect(environment).not.toBe(process.env);
    expect(environment?.CLAUDE_CODE_ENTRYPOINT).toBe("pocketpilot");
    expect(
      Object.entries(process.env).every(
        ([key, value]) =>
          key === "CLAUDE_CODE_ENTRYPOINT" || environment?.[key] === value,
      ),
    ).toBe(true);
    expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBe(parentEntrypoint);
  });

  it("forwards task-selected model and permission mode when opening a session", () => {
    let model: string | undefined;
    let permissionMode: PermissionMode | undefined;

    openClaudeSdkSession(
      {
        cwd: process.cwd(),
        model: "sonnet",
        permissionMode: "plan",
      },
      (params) => {
        model = params.options?.model;
        permissionMode = params.options?.permissionMode;
        return createFakeQuery();
      },
    );

    expect(model).toBe("sonnet");
    expect(permissionMode).toBe("plan");
  });
});

function sdkUserMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}
