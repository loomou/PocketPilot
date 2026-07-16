import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "dotenv";
import { z } from "zod";

import {
  AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE,
  AGENT_NEW_MASTER_KEY_ENVIRONMENT_VARIABLE,
} from "../storage/master-key.js";
import { EnvironmentConfigurationError } from "./errors.js";

export const AGENT_DATA_DIRECTORY_ENVIRONMENT_VARIABLE = "POCKETPILOT_DATA_DIR";
export const LOCAL_ADMIN_PORT_ENVIRONMENT_VARIABLE =
  "POCKETPILOT_LOCAL_ADMIN_PORT";

const dotenvAllowlist = [
  AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE,
  AGENT_NEW_MASTER_KEY_ENVIRONMENT_VARIABLE,
  AGENT_DATA_DIRECTORY_ENVIRONMENT_VARIABLE,
  LOCAL_ADMIN_PORT_ENVIRONMENT_VARIABLE,
] as const;

const localAdminPortSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(65_535));

export type LoadPocketPilotEnvironmentOptions = {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
};

/** Loads only PocketPilot bootstrap keys from the exact cwd .env file. */
export function loadPocketPilotEnvironment(
  options: LoadPocketPilotEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const environment = options.environment ?? process.env;
  const mergedEnvironment = { ...environment };
  const dotenvPath = join(options.cwd ?? process.cwd(), ".env");

  let source: Buffer;
  try {
    source = readFileSync(dotenvPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return mergedEnvironment;
    }
    throw new EnvironmentConfigurationError(
      "DOTENV_READ_FAILED",
      "The PocketPilot .env file in the startup directory could not be read.",
    );
  }

  const parsed = parse(source);
  for (const key of dotenvAllowlist) {
    if (mergedEnvironment[key] === undefined && parsed[key] !== undefined) {
      mergedEnvironment[key] = parsed[key];
    }
  }
  return mergedEnvironment;
}

export function readLocalAdminPort(
  environment: NodeJS.ProcessEnv,
): number | undefined {
  const value = environment[LOCAL_ADMIN_PORT_ENVIRONMENT_VARIABLE];
  if (value === undefined) {
    return undefined;
  }
  const result = localAdminPortSchema.safeParse(value);
  if (!result.success) {
    throw invalidEnvironmentValue(
      `${LOCAL_ADMIN_PORT_ENVIRONMENT_VARIABLE} must be an integer from 1 through 65535.`,
    );
  }
  return result.data;
}

export function readAgentDataDirectory(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const value = environment[AGENT_DATA_DIRECTORY_ENVIRONMENT_VARIABLE];
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw invalidEnvironmentValue(
      "POCKETPILOT_DATA_DIR must be a non-empty path.",
    );
  }
  return value;
}

function invalidEnvironmentValue(
  message: string,
): EnvironmentConfigurationError {
  return new EnvironmentConfigurationError(
    "ENVIRONMENT_VALUE_INVALID",
    message,
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
