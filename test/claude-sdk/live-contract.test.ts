import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { openClaudeSdkSession } from "../../src/claude-sdk/session.js";

const runLiveSdkContracts = process.env.CLAUDE_SDK_LIVE === "1";

describe.runIf(runLiveSdkContracts)("Claude Agent SDK live contracts", () => {
  it("discovers initialization and models, then accepts a later turn on one input stream", async () => {
    const session = openClaudeSdkSession(
      {
        cwd: process.cwd(),
      },
      query,
    );

    const events = session.events();
    session.submit(sdkUserMessage("Reply with exactly: ready"));
    await waitForMessage(events, "system", "init");
    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const initialization = await session.initialize();
    expect(initialization.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: expect.any(String),
          value: expect.any(String),
        }),
      ]),
    );

    await waitForMessage(events, "result");
    await session.setPermissionMode("default");
    await session.setModel(initialization.models[0]?.value);
    session.submit(sdkUserMessage("Reply with exactly: continued"));
    await waitForMessage(events, "result");
    await session.interrupt();
    session.close();
  }, 60_000);
});

async function waitForMessage(
  events: AsyncIterator<SDKMessage>,
  expectedType: SDKMessage["type"],
  expectedSubtype?: string,
): Promise<void> {
  while (true) {
    const event = await events.next();
    if (event.done) {
      throw new Error(`Claude SDK ended before emitting ${expectedType}.`);
    }

    if (
      event.value.type === expectedType &&
      (expectedSubtype === undefined ||
        ("subtype" in event.value && event.value.subtype === expectedSubtype))
    ) {
      return;
    }
  }
}

function sdkUserMessage(content: string) {
  return {
    type: "user" as const,
    message: { role: "user" as const, content },
    parent_tool_use_id: null,
  };
}
