import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { createSdkUserMessage } from "../../src/claude-sdk/input.js";
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
    session.submit(createSdkUserMessage("Reply with exactly: ready"));
    await waitForEvent(events, "session.initialized");
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

    await waitForEvent(events, "turn.result");
    await session.setPermissionMode("default");
    await session.setModel(initialization.models[0]?.value);
    session.submit(createSdkUserMessage("Reply with exactly: continued"));
    await waitForEvent(events, "turn.result");
    await session.interrupt();
    session.close();
  }, 60_000);
});

async function waitForEvent(
  events: AsyncIterator<{ kind: string }>,
  expectedKind: string,
): Promise<void> {
  while (true) {
    const event = await events.next();
    if (event.done) {
      throw new Error(`Claude SDK ended before emitting ${expectedKind}.`);
    }

    if (event.value.kind === expectedKind) {
      return;
    }
  }
}
