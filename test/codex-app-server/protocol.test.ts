import { describe, expect, it } from "vitest";

import {
  isCodexClientRequestFrame,
  isCodexReadClientRequestMethod,
  isCodexTurnStartingMethod,
  isSupportedCodexReviewTarget,
  parseCodexClientFrame,
} from "../../src/codex-app-server/protocol.js";

describe("Codex native transport guard", () => {
  it("accepts allowlisted JSON-RPC turn requests without wrapping them", () => {
    const frame = parseCodexClientFrame(
      JSON.stringify({
        id: "turn-1",
        method: "turn/start",
        params: { input: [{ text: "hello", text_elements: [], type: "text" }] },
      }),
    );

    expect(frame).toBeDefined();
    expect(frame && isCodexClientRequestFrame(frame)).toBe(true);
    expect(frame).toEqual({
      id: "turn-1",
      method: "turn/start",
      params: { input: [{ text: "hello", text_elements: [], type: "text" }] },
    });
  });

  it("accepts native review, rename, and compact requests without wrapping them", () => {
    for (const frame of [
      {
        id: 21,
        method: "review/start",
        params: {
          delivery: "inline",
          target: { type: "uncommittedChanges" },
          threadId: "thr_123",
        },
      },
      {
        id: 22,
        method: "thread/name/set",
        params: { name: "Provider parity audit", threadId: "thr_123" },
      },
      {
        id: 23,
        method: "thread/compact/start",
        params: { threadId: "thr_123" },
      },
    ]) {
      expect(parseCodexClientFrame(JSON.stringify(frame))).toEqual(frame);
    }
  });

  it("rejects binary frames and privileged methods", () => {
    expect(parseCodexClientFrame(Buffer.from("{}"), true)).toBeUndefined();
    expect(
      parseCodexClientFrame(
        JSON.stringify({
          id: 1,
          method: "account/logout",
          params: {},
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps Codex model, effort, collaboration, and permission catalogs native", () => {
    for (const method of [
      "model/list",
      "collaborationMode/list",
      "permissionProfile/list",
    ]) {
      expect(
        parseCodexClientFrame(
          JSON.stringify({ id: method, method, params: {} }),
        ),
      ).toMatchObject({ id: method, method, params: {} });
    }
  });

  it("classifies native catalogs and history as P3 reads", () => {
    for (const method of [
      "model/list",
      "collaborationMode/list",
      "permissionProfile/list",
      "thread/read",
      "thread/turns/list",
      "thread/items/list",
    ]) {
      expect(isCodexReadClientRequestMethod(method)).toBe(true);
    }
    for (const method of [
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "review/start",
      "thread/name/set",
      "thread/compact/start",
    ]) {
      expect(isCodexReadClientRequestMethod(method)).toBe(false);
    }
  });

  it("classifies review and compact as turn-starting methods", () => {
    expect(isCodexTurnStartingMethod("turn/start")).toBe(true);
    expect(isCodexTurnStartingMethod("review/start")).toBe(true);
    expect(isCodexTurnStartingMethod("thread/compact/start")).toBe(true);
    expect(isCodexTurnStartingMethod("thread/name/set")).toBe(false);
    expect(isCodexTurnStartingMethod("turn/steer")).toBe(false);
  });

  it("accepts only the reviewed native review targets", () => {
    expect(isSupportedCodexReviewTarget({ type: "uncommittedChanges" })).toBe(
      true,
    );
    expect(
      isSupportedCodexReviewTarget({
        branch: "main",
        type: "baseBranch",
      }),
    ).toBe(true);
    expect(
      isSupportedCodexReviewTarget({
        sha: "abc123",
        title: "fix",
        type: "commit",
      }),
    ).toBe(true);
    expect(
      isSupportedCodexReviewTarget({
        instructions: "focus on security",
        type: "custom",
      }),
    ).toBe(true);
    expect(isSupportedCodexReviewTarget({ type: "detached" })).toBe(false);
    expect(isSupportedCodexReviewTarget({ type: "baseBranch" })).toBe(false);
    expect(
      isSupportedCodexReviewTarget({
        instructions: "   ",
        type: "custom",
      }),
    ).toBe(false);
  });
});
