import { Command } from "commander";

import { runStartCommand, runStopCommand } from "../runtime/commands.js";
import {
  runRekeyCommand,
  runResetCommand,
} from "../runtime/maintenance-commands.js";

const COMMAND_DESCRIPTIONS = {
  start: "Start the Agent in the foreground.",
  stop: "Request a coordinated shutdown of the running Agent.",
  rekey: "Re-encrypt Agent-managed data with a replacement master key.",
  reset: "Reset Agent-managed data after explicit confirmation.",
} as const;

export type ProgramActions = {
  rekey(): Promise<void> | void;
  reset(confirmation: string): Promise<void> | void;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
};

const defaultProgramActions: ProgramActions = {
  rekey: runRekeyCommand,
  reset: runResetCommand,
  start: runStartCommand,
  stop: runStopCommand,
};

export function createProgram(
  actions: ProgramActions = defaultProgramActions,
): Command {
  const program = new Command();

  program
    .name("agent")
    .description("PocketPilot local Agent control CLI.")
    .showSuggestionAfterError();

  program
    .command("start")
    .description(COMMAND_DESCRIPTIONS.start)
    .action(() => actions.start());

  program
    .command("stop")
    .description(COMMAND_DESCRIPTIONS.stop)
    .action(() => actions.stop());

  program
    .command("rekey")
    .description(COMMAND_DESCRIPTIONS.rekey)
    .action(() => actions.rekey());

  program
    .command("reset")
    .description(COMMAND_DESCRIPTIONS.reset)
    .requiredOption(
      "--confirm <value>",
      "Confirm deletion of Agent-managed data.",
    )
    .action((options: { confirm: string }) => actions.reset(options.confirm));

  return program;
}
