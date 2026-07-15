import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEncryptionContext,
  decryptText,
  encryptText,
  parseEncryptedValueEnvelope,
} from "../../src/storage/crypto.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import {
  MasterKeyError,
  StorageCryptoError,
  StorageResetConfirmationError,
} from "../../src/storage/errors.js";
import {
  clearTransientEventOverflow,
  pruneStorage,
  rekeySensitiveData,
  resetAgentData,
  resetConfirmationValue,
} from "../../src/storage/maintenance.js";

describe("storage maintenance", () => {
  const temporaryDirectories: string[] = [];
  const connections: StorageConnection[] = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("re-encrypts every sensitive row atomically", () => {
    const connection = createTemporaryStorage(
      connections,
      temporaryDirectories,
    );
    const oldMasterKey = randomBytes(32);
    const newMasterKey = randomBytes(32);
    insertStorageFixtures(connection, oldMasterKey, 1_000);

    expect(
      rekeySensitiveData(connection.sqlite, oldMasterKey, newMasterKey),
    ).toBe(4);

    const credentialEnvelope = selectEnvelope(
      connection,
      "SELECT secret_envelope AS envelope FROM device_credentials WHERE id = ?",
      ["credential-1"],
    );
    expect(
      decryptText(
        newMasterKey,
        createEncryptionContext({
          column: "secret_envelope",
          recordId: "credential-1",
          table: "device_credentials",
        }),
        parseEncryptedValueEnvelope(credentialEnvelope),
      ),
    ).toBe("refresh-secret");
    expect(() =>
      decryptText(
        oldMasterKey,
        createEncryptionContext({
          column: "secret_envelope",
          recordId: "credential-1",
          table: "device_credentials",
        }),
        parseEncryptedValueEnvelope(credentialEnvelope),
      ),
    ).toThrow(StorageCryptoError);

    const accessTokenEnvelope = selectEnvelope(
      connection,
      "SELECT secret_envelope AS envelope FROM access_tokens WHERE id = ?",
      ["access-token-1"],
    );
    expect(
      decryptText(
        newMasterKey,
        createEncryptionContext({
          column: "secret_envelope",
          recordId: "access-token-1",
          table: "access_tokens",
        }),
        parseEncryptedValueEnvelope(accessTokenEnvelope),
      ),
    ).toBe("access-verifier");
  });

  it("rejects an invalid rekey key before scanning any rows", () => {
    const connection = createTemporaryStorage(
      connections,
      temporaryDirectories,
    );

    expect(() =>
      rekeySensitiveData(connection.sqlite, randomBytes(31), randomBytes(32)),
    ).toThrow(MasterKeyError);
  });

  it("rolls back rekeying when any stored envelope is corrupt", () => {
    const connection = createTemporaryStorage(
      connections,
      temporaryDirectories,
    );
    const oldMasterKey = randomBytes(32);
    const newMasterKey = randomBytes(32);
    insertStorageFixtures(connection, oldMasterKey, 1_000);
    connection.sqlite
      .prepare("UPDATE pairings SET secret_envelope = ? WHERE id = ?")
      .run("not-json", "pairing-1");

    expect(() =>
      rekeySensitiveData(connection.sqlite, oldMasterKey, newMasterKey),
    ).toThrow(StorageCryptoError);

    const credentialEnvelope = selectEnvelope(
      connection,
      "SELECT secret_envelope AS envelope FROM device_credentials WHERE id = ?",
      ["credential-1"],
    );
    expect(
      decryptText(
        oldMasterKey,
        createEncryptionContext({
          column: "secret_envelope",
          recordId: "credential-1",
          table: "device_credentials",
        }),
        parseEncryptedValueEnvelope(credentialEnvelope),
      ),
    ).toBe("refresh-secret");
  });

  it("prunes retained records, clears transient events, and requires reset confirmation", () => {
    const connection = createTemporaryStorage(
      connections,
      temporaryDirectories,
    );
    const masterKey = randomBytes(32);
    const now = 3_000_000_000;
    insertStorageFixtures(connection, masterKey, now - 1);
    connection.sqlite
      .prepare(
        "INSERT INTO operation_results (device_id, operation_id, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("device-1", "operation-1", "{}", now - 1, now - 1);
    connection.sqlite
      .prepare(
        "INSERT INTO audit_records (id, occurred_at, operation, result) VALUES (?, ?, ?, ?)",
      )
      .run("audit-1", now - 30 * 24 * 60 * 60 * 1000 - 1, "test", "ok");

    expect(pruneStorage(connection.sqlite, now)).toEqual({
      accessTokens: 1,
      auditRecords: 1,
      expiredAuthChallenges: 0,
      expiredOperationResults: 1,
      expiredPairings: 1,
    });
    expect(clearTransientEventOverflow(connection.sqlite)).toBe(1);
    expect(() => resetAgentData(connection.sqlite, "no")).toThrow(
      StorageResetConfirmationError,
    );

    resetAgentData(connection.sqlite, resetConfirmationValue());
    expect(
      connection.sqlite.prepare("SELECT COUNT(*) AS count FROM devices").get(),
    ).toEqual({ count: 0 });
    expect(
      connection.sqlite.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
    ).toEqual({ count: 0 });
  });
});

function createTemporaryStorage(
  connections: StorageConnection[],
  temporaryDirectories: string[],
): StorageConnection {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-storage-"));
  const connection = openStorage({
    databasePath: join(directory, "agent.sqlite"),
  });

  temporaryDirectories.push(directory);
  connections.push(connection);
  return connection;
}

function insertStorageFixtures(
  connection: StorageConnection,
  masterKey: Buffer,
  now: number,
): void {
  connection.sqlite
    .prepare(
      "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
    )
    .run("device-1", "Test device", "public-key", now);
  connection.sqlite
    .prepare(
      "INSERT INTO tasks (id, initial_cwd, permission_mode, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("task-1", "C:\\Workspace", "default", "idle", now, now);
  connection.sqlite
    .prepare(
      "INSERT INTO device_credentials (id, device_id, secret_envelope, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "credential-1",
      "device-1",
      JSON.stringify(
        encryptText(
          masterKey,
          createEncryptionContext({
            column: "secret_envelope",
            recordId: "credential-1",
            table: "device_credentials",
          }),
          "refresh-secret",
        ),
      ),
      now,
      now,
    );
  connection.sqlite
    .prepare(
      "INSERT INTO access_tokens (id, device_id, secret_envelope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "access-token-1",
      "device-1",
      JSON.stringify(
        encryptText(
          masterKey,
          createEncryptionContext({
            column: "secret_envelope",
            recordId: "access-token-1",
            table: "access_tokens",
          }),
          "access-verifier",
        ),
      ),
      now,
      now + 1,
    );
  connection.sqlite
    .prepare(
      "INSERT INTO pairings (id, secret_envelope, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      "pairing-1",
      JSON.stringify(
        encryptText(
          masterKey,
          createEncryptionContext({
            column: "secret_envelope",
            recordId: "pairing-1",
            table: "pairings",
          }),
          "pairing-secret",
        ),
      ),
      now,
      now,
    );
  connection.sqlite
    .prepare(
      "INSERT INTO event_overflow (task_id, cursor, payload_envelope, byte_length, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "task-1",
      1,
      JSON.stringify(
        encryptText(
          masterKey,
          createEncryptionContext({
            column: "payload_envelope",
            recordId: "task-1:1",
            table: "event_overflow",
          }),
          "event-payload",
        ),
      ),
      13,
      now,
    );
}

function selectEnvelope(
  connection: StorageConnection,
  query: string,
  parameters: [string],
): string {
  const row = connection.sqlite
    .prepare<[string], { envelope: string }>(query)
    .get(...parameters);
  if (row === undefined) {
    throw new Error("Expected encrypted storage row was not found.");
  }

  return row.envelope;
}
