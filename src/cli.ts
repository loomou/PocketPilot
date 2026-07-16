#!/usr/bin/env node
import { CommanderError } from "commander";

import { createProgram, createProgramActions } from "./cli/program.js";
import { loadPocketPilotEnvironment } from "./config/environment.js";
import { EnvironmentConfigurationError } from "./config/errors.js";
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

try {
  const environment = loadPocketPilotEnvironment();
  const program = createProgram(createProgramActions(environment));
  await program.parseAsync();
} catch (error: unknown) {
  if (
    error instanceof AgentMaintenanceError ||
    error instanceof EnvironmentConfigurationError ||
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
