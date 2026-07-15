import { Command } from "commander";

import { requireRuntimeImplementation } from "./bootstrap-command.js";

const COMMAND_DESCRIPTIONS = {
  start: "Start the Agent in the foreground.",
  stop: "Request a coordinated shutdown of the running Agent.",
  rekey: "Re-encrypt Agent-managed data with a replacement master key.",
  reset: "Reset Agent-managed data after explicit confirmation.",
} as const;

export function createProgram(): Command {
  const program = new Command();

  program
    .name("agent")
    .description("PocketPilot local Agent control CLI.")
    .showSuggestionAfterError();

  for (const [commandName, description] of Object.entries(
    COMMAND_DESCRIPTIONS,
  )) {
    program
      .command(commandName)
      .description(description)
      .action(() => requireRuntimeImplementation(commandName));
  }

  return program;
}
