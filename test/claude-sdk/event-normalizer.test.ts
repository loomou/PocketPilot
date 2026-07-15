import type { SDKStatusMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { normalizeSdkMessage } from "../../src/claude-sdk/event-normalizer.js";
import { createSdkUserMessage } from "../../src/claude-sdk/input.js";

const statusMessage = {
  type: "system",
  subtype: "status",
  status: "requesting",
  uuid: "00000000-0000-0000-0000-000000000003",
  session_id: "session-1",
} satisfies SDKStatusMessage;

describe("Claude SDK event normalization", () => {
  it("retains non-special SDK system events at the adapter boundary", () => {
    expect(normalizeSdkMessage(statusMessage)).toEqual({
      kind: "sdk.system",
      message: statusMessage,
    });
  });

  it("does not replay an instruction that the mobile client already owns", () => {
    expect(
      normalizeSdkMessage(createSdkUserMessage("already displayed")),
    ).toBeUndefined();
  });
});
