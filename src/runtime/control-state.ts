import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { RuntimeControlError } from "./errors.js";

const runtimeControlStateSchema = z.object({
  localAdminPort: z.number().int().min(1).max(65_535),
  shutdownControlToken: z.string().min(32),
  version: z.literal(1),
});

export type RuntimeControlState = z.infer<typeof runtimeControlStateSchema>;

export async function readRuntimeControlState(
  controlStatePath: string,
): Promise<RuntimeControlState> {
  let contents: string;
  try {
    contents = await readFile(controlStatePath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      throw new RuntimeControlError(
        "RUNTIME_NOT_RUNNING",
        "The Agent is not currently running.",
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new RuntimeControlError(
      "RUNTIME_STATE_INVALID",
      "The Agent runtime state file is invalid.",
    );
  }

  const result = runtimeControlStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new RuntimeControlError(
      "RUNTIME_STATE_INVALID",
      "The Agent runtime state file is invalid.",
    );
  }

  return result.data;
}

export async function writeRuntimeControlState(
  controlStatePath: string,
  state: RuntimeControlState,
): Promise<void> {
  await mkdir(dirname(controlStatePath), { recursive: true });
  const temporaryPath = `${controlStatePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, controlStatePath);
}

export async function removeRuntimeControlState(
  controlStatePath: string,
  expectedShutdownControlToken: string | undefined,
): Promise<void> {
  if (expectedShutdownControlToken === undefined) {
    return;
  }

  try {
    const state = await readRuntimeControlState(controlStatePath);
    if (state.shutdownControlToken !== expectedShutdownControlToken) {
      return;
    }
  } catch (error: unknown) {
    if (error instanceof RuntimeControlError) {
      return;
    }
    throw error;
  }

  await rm(controlStatePath, { force: true });
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
