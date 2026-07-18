import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  AGENT_DATA_DIRECTORY_ENVIRONMENT_VARIABLE,
  readAgentDataDirectory,
  readLocalAdminPort,
  readLogLevel,
} from "../config/environment.js";
import { createPocketPilotLogger } from "../logging/logger.js";
import { AgentRuntime } from "./agent-runtime.js";
import { readRuntimeControlState } from "./control-state.js";
import { RuntimeControlError } from "./errors.js";

export { AGENT_DATA_DIRECTORY_ENVIRONMENT_VARIABLE };

export type AgentRuntimePaths = {
  databasePath: string;
  runtimeControlPath: string;
};

export function isDevelopmentRuntimeModule(moduleUrl: string): boolean {
  return new URL(moduleUrl).pathname.toLowerCase().endsWith(".ts");
}

export function resolveAgentRuntimePaths(
  environment: NodeJS.ProcessEnv = process.env,
): AgentRuntimePaths {
  const configuredDataDirectory = readAgentDataDirectory(environment);
  const dataDirectory =
    configuredDataDirectory === undefined
      ? defaultAgentDataDirectory(environment)
      : resolve(configuredDataDirectory);

  return {
    databasePath: join(dataDirectory, "agent.sqlite"),
    runtimeControlPath: join(dataDirectory, "runtime-control.json"),
  };
}

export async function runStartCommand(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = resolveAgentRuntimePaths(environment);
  const localAdminPort = readLocalAdminPort(environment);
  const logger = createPocketPilotLogger({
    environment,
    level: readLogLevel(environment),
  });
  const runtime = new AgentRuntime({
    databasePath: paths.databasePath,
    developmentMode: isDevelopmentRuntimeModule(import.meta.url),
    environment,
    ...(localAdminPort === undefined ? {} : { localAdminPort }),
    logger,
    runtimeControlPath: paths.runtimeControlPath,
  });
  await runtime.start();
  await runtime.waitUntilStopped();
}

export async function runStopCommand(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = resolveAgentRuntimePaths(environment);
  await requestRuntimeShutdown(paths.runtimeControlPath);
}

export async function requestRuntimeShutdown(
  runtimeControlPath: string,
): Promise<void> {
  const state = await readRuntimeControlState(runtimeControlPath);
  let response: Response;
  try {
    response = await fetch(
      `http://127.0.0.1:${state.localAdminPort}/_internal/shutdown`,
      {
        headers: {
          "x-pocketpilot-control-token": state.shutdownControlToken,
        },
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch {
    throw new RuntimeControlError(
      "RUNTIME_CONTROL_UNAVAILABLE",
      "The Agent runtime state is stale or the local control listener is unavailable.",
    );
  }

  if (response.status !== 202) {
    throw new RuntimeControlError(
      "RUNTIME_CONTROL_REJECTED",
      "The running Agent rejected the stop request.",
    );
  }
}

function defaultAgentDataDirectory(environment: NodeJS.ProcessEnv): string {
  const windowsLocalAppData = environment.LOCALAPPDATA;
  return join(windowsLocalAppData ?? homedir(), "PocketPilot");
}
