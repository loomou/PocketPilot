import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";

import type BetterSqlite3 from "better-sqlite3";

import { openStorage } from "../storage/database.js";
import {
  assertResetConfirmation,
  rekeySensitiveData,
  resetAgentData,
} from "../storage/maintenance.js";
import {
  readAgentMasterKey,
  readNewAgentMasterKey,
} from "../storage/master-key.js";
import { acquireAgentLock } from "./agent-lock.js";
import { resolveAgentRuntimePaths } from "./commands.js";
import { AgentMaintenanceError } from "./errors.js";

type WriteOutput = (message: string) => void;

export async function runRekeyCommand(
  environment: NodeJS.ProcessEnv = process.env,
  writeOutput: WriteOutput = console.log,
): Promise<void> {
  const oldMasterKey = readAgentMasterKey(environment);
  try {
    const newMasterKey = readNewAgentMasterKey(environment);
    try {
      if (timingSafeEqual(oldMasterKey, newMasterKey)) {
        throw new AgentMaintenanceError(
          "MASTER_KEYS_IDENTICAL",
          "AGENT_NEW_MASTER_KEY must differ from AGENT_MASTER_KEY.",
        );
      }

      const migrated = await withStoppedAgentStorage(environment, (sqlite) =>
        rekeySensitiveData(sqlite, oldMasterKey, newMasterKey),
      );
      writeOutput(`Re-encrypted ${migrated} sensitive Agent record(s).`);
    } finally {
      newMasterKey.fill(0);
    }
  } finally {
    oldMasterKey.fill(0);
  }
}

export async function runResetCommand(
  confirmation: string,
  environment: NodeJS.ProcessEnv = process.env,
  writeOutput: WriteOutput = console.log,
): Promise<void> {
  assertResetConfirmation(confirmation);
  await withStoppedAgentStorage(environment, (sqlite) => {
    resetAgentData(sqlite, confirmation);
  });
  writeOutput("Reset Agent-managed data.");
}

async function withStoppedAgentStorage<T>(
  environment: NodeJS.ProcessEnv,
  operation: (sqlite: BetterSqlite3.Database) => T,
): Promise<T> {
  const { databasePath } = resolveAgentRuntimePaths(environment);
  if (!existsSync(databasePath)) {
    throw new AgentMaintenanceError(
      "AGENT_DATA_NOT_FOUND",
      "No PocketPilot Agent data exists at the configured data directory.",
    );
  }

  const releaseLock = await acquireAgentLock(databasePath);
  try {
    const storage = openStorage({ databasePath });
    try {
      return operation(storage.sqlite);
    } finally {
      storage.close();
    }
  } finally {
    await releaseLock();
  }
}
