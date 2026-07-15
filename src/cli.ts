#!/usr/bin/env node
import { CommanderError } from "commander";

import { BootstrapCommandUnavailableError } from "./cli/bootstrap-command.js";
import { createProgram } from "./cli/program.js";

const program = createProgram();

try {
  await program.parseAsync();
} catch (error: unknown) {
  if (error instanceof BootstrapCommandUnavailableError) {
    console.error(error.message);
    process.exitCode = error.exitCode;
  } else if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
