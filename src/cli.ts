#!/usr/bin/env node
import { CommanderError } from "commander";

import { createProgram } from "./cli/program.js";
import {
  AgentMaintenanceError,
  RuntimeControlError,
} from "./runtime/errors.js";
import {
  MasterKeyError,
  StorageCryptoError,
  StorageDataError,
  StorageResetConfirmationError,
} from "./storage/errors.js";

const program = createProgram();

try {
  await program.parseAsync();
} catch (error: unknown) {
  if (
    error instanceof AgentMaintenanceError ||
    error instanceof MasterKeyError ||
    error instanceof RuntimeControlError ||
    error instanceof StorageCryptoError ||
    error instanceof StorageDataError ||
    error instanceof StorageResetConfirmationError
  ) {
    console.error(error.message);
    process.exitCode = 1;
  } else if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
