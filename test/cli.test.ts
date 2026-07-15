import { describe, expect, it } from "vitest";

import { createProgram } from "../src/cli/program.js";

describe("createProgram", () => {
  it("exposes the required local control commands", () => {
    const commandNames = createProgram().commands.map((command) =>
      command.name(),
    );

    expect(commandNames).toEqual(["start", "stop", "rekey", "reset"]);
  });
});
