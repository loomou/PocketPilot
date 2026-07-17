import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { ClaudeSdkInputStream } from "../../src/claude-sdk/input.js";

describe("Claude SDK input", () => {
  it("preserves raw SDK user messages", async () => {
    const input = new ClaudeSdkInputStream();
    const iterator = input[Symbol.asyncIterator]();
    const message = {
      type: "user",
      message: {
        role: "user",
        content: "Summarize the repository.",
      },
      parent_tool_use_id: null,
      priority: "later",
      shouldQuery: false,
    } satisfies SDKUserMessage;

    input.push(message);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: message,
    });
    input.close();
  });

  it("keeps later instructions on one long-lived SDK input stream", async () => {
    const input = new ClaudeSdkInputStream();
    const iterator = input[Symbol.asyncIterator]();

    input.push(sdkUserMessage("first turn"));
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        message: { content: "first turn" },
      },
    });

    const secondConsumer = input[Symbol.asyncIterator]();
    await expect(secondConsumer.next()).rejects.toThrow(
      "A Claude SDK input stream can only be consumed once.",
    );

    const nextMessage = iterator.next();
    input.push(sdkUserMessage("later turn"));
    await expect(nextMessage).resolves.toMatchObject({
      done: false,
      value: {
        message: { content: "later turn" },
      },
    });

    input.close();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(() => input.push(sdkUserMessage("after close"))).toThrow(
      "Cannot add a message to a closed Claude SDK input stream.",
    );
  });
});

function sdkUserMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}
