import { describe, expect, it } from "vitest";

import {
  isCodexClientRequestFrame,
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
});
