import type {
  ModelInfo,
  PermissionMode,
  SDKControlInitializeResponse,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKSessionStateChangedMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createSdkUserMessage } from "../../src/claude-sdk/input.js";
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

    session.submit(createSdkUserMessage("later instruction"));
    await session.setModel("sonnet");
    await session.setPermissionMode("plan");
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
      "interrupt",
      "close",
    ]);
  });

  it("normalizes only relayable output and lifecycle events", async () => {
    const session = openClaudeSdkSession(
      {
        cwd: process.cwd(),
      },
      () => createFakeQuery(),
    );

    await expect(collectAsync(session.events())).resolves.toEqual([
      {
        kind: "session.state-changed",
        message: stateChangeMessage,
      },
    ]);
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
    let resume: string | undefined;

    openClaudeSdkSession(
      {
        cwd: process.cwd(),
        resume: "00000000-0000-0000-0000-000000000002",
      },
      (params) => {
        resume = params.options?.resume;
        return fakeQuery;
      },
    );

    expect(resume).toBe("00000000-0000-0000-0000-000000000002");
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
