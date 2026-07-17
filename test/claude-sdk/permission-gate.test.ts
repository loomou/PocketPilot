import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import {
  createToolApprovalHandler,
  type PendingToolApproval,
  ToolApprovalCancelledError,
} from "../../src/claude-sdk/permission-gate.js";

function createApprovalRequest(signal: AbortSignal): Parameters<CanUseTool>[2] {
  return {
    agentID: "agent-1",
    blockedPath: "README.md",
    decisionReason: "The path requires explicit approval.",
    signal,
    suggestions: [
      {
        behavior: "allow",
        destination: "session",
        rules: [{ toolName: "Read", ruleContent: "README.md" }],
        type: "addRules",
      },
    ],
    toolUseID: "tool-use-1",
    requestId: "request-1",
    title: "Claude wants to read README.md",
    displayName: "Read file",
    description: "Read access is needed to answer the request.",
  };
}

describe("Claude SDK tool approval gate", () => {
  it("exposes an SDK tool request and resolves the user's decision", async () => {
    let pending: PendingToolApproval | undefined;
    const canUseTool = createToolApprovalHandler((approval) => {
      pending = approval;
    });

    const decision = canUseTool(
      "Read",
      { file_path: "README.md" },
      createApprovalRequest(new AbortController().signal),
    );

    expect(pending?.options).toEqual({
      agentID: "agent-1",
      blockedPath: "README.md",
      decisionReason: "The path requires explicit approval.",
      description: "Read access is needed to answer the request.",
      displayName: "Read file",
      requestId: "request-1",
      suggestions: [
        {
          behavior: "allow",
          destination: "session",
          rules: [{ toolName: "Read", ruleContent: "README.md" }],
          type: "addRules",
        },
      ],
      title: "Claude wants to read README.md",
      toolUseID: "tool-use-1",
    });
    expect(pending?.toolName).toBe("Read");
    const result = {
      behavior: "allow",
      decisionClassification: "user_temporary",
      toolUseID: "tool-use-1",
      updatedInput: { file_path: "README.md" },
      updatedPermissions: pending?.options.suggestions ?? [],
    } satisfies PermissionResult;
    pending?.resolve(result);

    await expect(decision).resolves.toBe(result);
  });

  it("rejects a pending approval when the SDK aborts it", async () => {
    let pending: PendingToolApproval | undefined;
    const controller = new AbortController();
    const canUseTool = createToolApprovalHandler((approval) => {
      pending = approval;
    });

    const decision = canUseTool(
      "Read",
      { file_path: "README.md" },
      createApprovalRequest(controller.signal),
    );

    expect(pending).toBeDefined();
    controller.abort();

    await expect(decision).rejects.toBeInstanceOf(ToolApprovalCancelledError);
  });

  it("does not allow a cancelled approval to be overwritten", async () => {
    let pending: PendingToolApproval | undefined;
    const canUseTool = createToolApprovalHandler((approval) => {
      pending = approval;
    });

    const decision = canUseTool(
      "Read",
      { file_path: "README.md" },
      createApprovalRequest(new AbortController().signal),
    );

    pending?.cancel("Task was closed.");
    pending?.resolve({ behavior: "allow" });

    await expect(decision).rejects.toMatchObject({
      message: "Task was closed.",
      name: "ToolApprovalCancelledError",
    });
  });
});
