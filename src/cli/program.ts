import { Command } from "commander";

import { runStartCommand, runStopCommand } from "../runtime/commands.js";
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

  program
    .command("start")
    .description(COMMAND_DESCRIPTIONS.start)
    .action(runStartCommand);

  program
    .command("stop")
    .description(COMMAND_DESCRIPTIONS.stop)
    .action(runStopCommand);

  for (const commandName of ["rekey", "reset"] as const) {
    program
      .command(commandName)
      .description(COMMAND_DESCRIPTIONS[commandName])
      .action(() => requireRuntimeImplementation(commandName));
  }

  return program;
}
