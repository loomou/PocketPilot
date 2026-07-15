import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { AgentRuntime } from "./agent-runtime.js";
import { readRuntimeControlState } from "./control-state.js";
import { RuntimeControlError } from "./errors.js";

export const AGENT_DATA_DIRECTORY_ENVIRONMENT_VARIABLE = "POCKETPILOT_DATA_DIR";

export type AgentRuntimePaths = {
  databasePath: string;
  runtimeControlPath: string;
};

export function resolveAgentRuntimePaths(
  environment: NodeJS.ProcessEnv = process.env,
): AgentRuntimePaths {
  const dataDirectory =
    environment[AGENT_DATA_DIRECTORY_ENVIRONMENT_VARIABLE] === undefined
      ? defaultAgentDataDirectory(environment)
      : resolve(environment[AGENT_DATA_DIRECTORY_ENVIRONMENT_VARIABLE]);

  return {
    databasePath: join(dataDirectory, "agent.sqlite"),
    runtimeControlPath: join(dataDirectory, "runtime-control.json"),
  };
}

export async function runStartCommand(): Promise<void> {
  const paths = resolveAgentRuntimePaths();
  const runtime = new AgentRuntime({
    databasePath: paths.databasePath,
    runtimeControlPath: paths.runtimeControlPath,
  });
  const status = await runtime.start();

  console.log(
    `PocketPilot Agent is running. Remote health: http://${status.remoteListener.host}:${status.remoteListener.port}/healthz`,
  );
  console.log(
    `Local administration: http://${status.localAdminListener.host}:${status.localAdminListener.port}`,
  );
  await runtime.waitUntilStopped();
}

export async function runStopCommand(): Promise<void> {
  const paths = resolveAgentRuntimePaths();
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
