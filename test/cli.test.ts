import { describe, expect, it, vi } from "vitest";

import { createProgram, type ProgramActions } from "../src/cli/program.js";

describe("createProgram", () => {
  it("exposes the required local control commands", () => {
    const commandNames = createProgram().commands.map((command) =>
      command.name(),
    );

    expect(commandNames).toEqual(["start", "stop", "rekey", "reset"]);
  });

  it("dispatches rekey and forwards explicit reset confirmation", async () => {
    const { actions, rekey, reset } = createActions();

    await createProgram(actions).parseAsync(["node", "agent", "rekey"]);
    await createProgram(actions).parseAsync([
      "node",
      "agent",
      "reset",
      "--confirm",
      "RESET_AGENT_DATA",
    ]);

    expect(rekey).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledWith("RESET_AGENT_DATA");
  });
});

function createActions() {
  const rekey = vi.fn<() => void>();
  const reset = vi.fn<(confirmation: string) => void>();
  const actions: ProgramActions = {
    rekey,
    reset,
    start: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
  };
  return { actions, rekey, reset };
}
