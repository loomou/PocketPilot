import { describe, expect, it } from "vitest";

import {
  ClaudeSdkInputStream,
  createSdkUserMessage,
  singleTurnInput,
} from "../../src/claude-sdk/input.js";
import { collectAsync } from "../helpers/collect-async.js";

describe("Claude SDK input", () => {
  it("marks instructions as human SDK messages", async () => {
    expect(createSdkUserMessage("Summarize the repository.")).toEqual({
      type: "user",
      message: {
        role: "user",
        content: "Summarize the repository.",
      },
      parent_tool_use_id: null,
      origin: {
        kind: "human",
      },
    });

    await expect(
      collectAsync(singleTurnInput("next turn")),
    ).resolves.toHaveLength(1);
  });

  it("keeps later instructions on one long-lived SDK input stream", async () => {
    const input = new ClaudeSdkInputStream();
    const iterator = input[Symbol.asyncIterator]();

    input.push(createSdkUserMessage("first turn"));
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
    input.push(createSdkUserMessage("later turn"));
    await expect(nextMessage).resolves.toMatchObject({
      done: false,
      value: {
        message: { content: "later turn" },
      },
    });

    input.close();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(() => input.push(createSdkUserMessage("after close"))).toThrow(
      "Cannot add an instruction to a closed Claude SDK input stream.",
    );
  });
});
