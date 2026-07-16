import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { lock } from "proper-lockfile";

import { AgentMaintenanceError } from "./errors.js";

const LOCK_STALE_MILLISECONDS = 30_000;
const LOCK_UPDATE_MILLISECONDS = 10_000;

export type ReleaseAgentLock = () => Promise<void>;

/** Prevents the runtime and stopped-only maintenance commands from overlapping. */
export async function acquireAgentLock(
  databasePath: string,
): Promise<ReleaseAgentLock> {
  try {
    await mkdir(dirname(databasePath), { recursive: true });
    const release = await lock(databasePath, {
      realpath: false,
      retries: 0,
      stale: LOCK_STALE_MILLISECONDS,
      update: LOCK_UPDATE_MILLISECONDS,
    });
    return async () => {
      try {
        await release();
      } catch {
        throw lockUnavailableError();
      }
    };
  } catch (error: unknown) {
    if (isLockContentionError(error)) {
      throw new AgentMaintenanceError(
        "AGENT_MAINTENANCE_LOCKED",
        "The Agent is running or another maintenance command is active.",
      );
    }
    throw lockUnavailableError();
  }
}

function lockUnavailableError(): AgentMaintenanceError {
  return new AgentMaintenanceError(
    "AGENT_MAINTENANCE_LOCK_UNAVAILABLE",
    "The Agent data lock could not be acquired or released safely.",
  );
}

function isLockContentionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ELOCKED"
  );
}
