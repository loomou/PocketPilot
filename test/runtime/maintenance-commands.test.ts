import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireAgentLock } from "../../src/runtime/agent-lock.js";
import {
  runRekeyCommand,
  runResetCommand,
} from "../../src/runtime/maintenance-commands.js";
import {
  createEncryptionContext,
  decryptText,
  encryptText,
  parseEncryptedValueEnvelope,
} from "../../src/storage/crypto.js";
import { openStorage } from "../../src/storage/database.js";
import {
  ensureMasterKeyVerifier,
  resetConfirmationValue,
} from "../../src/storage/maintenance.js";

describe("stopped Agent maintenance commands", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rekeys encrypted data and the persistent master-key verifier", async () => {
    const fixture = createMaintenanceFixture(temporaryDirectories);
    const output: string[] = [];

    await runRekeyCommand(
      maintenanceEnvironment(
        fixture.directory,
        fixture.oldMasterKey,
        fixture.newMasterKey,
      ),
      (message) => output.push(message),
    );

    const storage = openStorage({ databasePath: fixture.databasePath });
    try {
      ensureMasterKeyVerifier(storage.sqlite, fixture.newMasterKey);
      expect(() =>
        ensureMasterKeyVerifier(storage.sqlite, fixture.oldMasterKey),
      ).toThrow();
      const row = storage.sqlite
        .prepare<[], { envelope: string }>(
          "SELECT secret_envelope AS envelope FROM device_credentials WHERE id = 'credential-1'",
        )
        .get();
      expect(row).toBeDefined();
      if (row !== undefined) {
        expect(
          decryptText(
            fixture.newMasterKey,
            createEncryptionContext({
              column: "secret_envelope",
              recordId: "credential-1",
              table: "device_credentials",
            }),
            parseEncryptedValueEnvelope(row.envelope),
          ),
        ).toBe("refresh-verifier");
      }
    } finally {
      storage.close();
    }
    expect(output).toEqual(["Re-encrypted 1 sensitive Agent record(s)."]);
  });

  it("blocks maintenance while the Agent data lock is held", async () => {
    const fixture = createMaintenanceFixture(temporaryDirectories);
    const releaseLock = await acquireAgentLock(fixture.databasePath);
    try {
      await expect(
        runResetCommand(
          resetConfirmationValue(),
          { POCKETPILOT_DATA_DIR: fixture.directory },
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "AGENT_MAINTENANCE_LOCKED" });
    } finally {
      await releaseLock();
    }
  });

  it("requires exact reset confirmation but not the lost old key", async () => {
    const fixture = createMaintenanceFixture(temporaryDirectories);
    const environment = { POCKETPILOT_DATA_DIR: fixture.directory };

    await expect(
      runResetCommand("no", environment, () => undefined),
    ).rejects.toThrow("explicit confirmation");
    await runResetCommand(
      resetConfirmationValue(),
      environment,
      () => undefined,
    );

    const storage = openStorage({ databasePath: fixture.databasePath });
    try {
      expect(
        storage.sqlite.prepare("SELECT COUNT(*) AS count FROM devices").get(),
      ).toEqual({ count: 0 });
      expect(
        storage.sqlite
          .prepare("SELECT COUNT(*) AS count FROM agent_settings")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      storage.close();
    }
  });

  it("rejects reset before opening Agent storage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-maintenance-"));
    temporaryDirectories.push(directory);

    await expect(
      runResetCommand(
        "no",
        { POCKETPILOT_DATA_DIR: directory },
        () => undefined,
      ),
    ).rejects.toThrow("explicit confirmation");
  });

  it("rejects identical rekey values and a missing data directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-maintenance-"));
    temporaryDirectories.push(directory);
    const key = randomBytes(32);

    await expect(
      runRekeyCommand(
        maintenanceEnvironment(directory, key, key),
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "MASTER_KEYS_IDENTICAL" });

    await expect(
      runResetCommand(
        resetConfirmationValue(),
        { POCKETPILOT_DATA_DIR: directory },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "AGENT_DATA_NOT_FOUND" });
  });
});

function createMaintenanceFixture(temporaryDirectories: string[]): {
  databasePath: string;
  directory: string;
  newMasterKey: Buffer;
  oldMasterKey: Buffer;
} {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-maintenance-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "agent.sqlite");
  const oldMasterKey = randomBytes(32);
  const newMasterKey = randomBytes(32);
  const storage = openStorage({ databasePath });
  try {
    ensureMasterKeyVerifier(storage.sqlite, oldMasterKey);
    storage.sqlite
      .prepare(
        "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("device-1", "Test device", "public-key", 1);
    storage.sqlite
      .prepare(
        "INSERT INTO device_credentials (id, device_id, secret_envelope, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "credential-1",
        "device-1",
        JSON.stringify(
          encryptText(
            oldMasterKey,
            createEncryptionContext({
              column: "secret_envelope",
              recordId: "credential-1",
              table: "device_credentials",
            }),
            "refresh-verifier",
          ),
        ),
        1,
        1,
      );
  } finally {
    storage.close();
  }
  return { databasePath, directory, newMasterKey, oldMasterKey };
}

function maintenanceEnvironment(
  directory: string,
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): NodeJS.ProcessEnv {
  return {
    AGENT_MASTER_KEY: oldMasterKey.toString("base64url"),
    AGENT_NEW_MASTER_KEY: newMasterKey.toString("base64url"),
    POCKETPILOT_DATA_DIR: directory,
  };
}
