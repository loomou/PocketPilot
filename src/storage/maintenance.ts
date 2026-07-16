import type BetterSqlite3 from "better-sqlite3";

import {
  createEncryptionContext,
  decryptText,
  encryptText,
  parseEncryptedValueEnvelope,
} from "./crypto.js";
import { StorageCryptoError, StorageResetConfirmationError } from "./errors.js";
import { assertMasterKey } from "./master-key.js";

const AUDIT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const RESET_CONFIRMATION = "RESET_AGENT_DATA";
const MASTER_KEY_VERIFIER_KEY = "storage.master-key-verifier";
const MASTER_KEY_VERIFIER_PLAINTEXT = "pocketpilot:master-key-verifier:v1";

type EncryptedColumn =
  | {
      column: "secret_envelope";
      table: "access_tokens" | "device_credentials" | "pairings";
    }
  | {
      column: "payload_envelope";
      table: "event_overflow";
    };

type EncryptedRecordRow = {
  envelope: string;
  id: string;
};

type EventOverflowRow = {
  cursor: number;
  envelope: string;
  taskId: string;
};

type MasterKeyVerifierRow = {
  valueJson: string;
};

type SensitiveEnvelope = {
  context: ReturnType<typeof createEncryptionContext>;
  serializedEnvelope: string;
};

const encryptedColumns: readonly EncryptedColumn[] = [
  { column: "secret_envelope", table: "access_tokens" },
  { column: "secret_envelope", table: "device_credentials" },
  { column: "secret_envelope", table: "pairings" },
  { column: "payload_envelope", table: "event_overflow" },
];

export type StoragePruneResult = {
  accessTokens: number;
  auditRecords: number;
  expiredAuthChallenges: number;
  expiredOperationResults: number;
  expiredPairings: number;
};

/** Re-encrypts all sensitive rows atomically while the Agent is stopped. */
export function rekeySensitiveData(
  sqlite: BetterSqlite3.Database,
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): number {
  assertMasterKey(oldMasterKey);
  assertMasterKey(newMasterKey);

  return sqlite.transaction(() => {
    ensureMasterKeyVerifier(sqlite, oldMasterKey);
    let migrated = 0;
    for (const encryptedColumn of encryptedColumns) {
      migrated += rekeyColumn(
        sqlite,
        encryptedColumn,
        oldMasterKey,
        newMasterKey,
      );
    }
    writeMasterKeyVerifier(sqlite, newMasterKey);
    return migrated;
  })();
}

/** Creates or authenticates the persistent key check before secure startup. */
export function ensureMasterKeyVerifier(
  sqlite: BetterSqlite3.Database,
  masterKey: Buffer,
): void {
  assertMasterKey(masterKey);
  sqlite.transaction(() => {
    const row = sqlite
      .prepare<[string], MasterKeyVerifierRow>(
        "SELECT value_json AS valueJson FROM agent_settings WHERE key = ?",
      )
      .get(MASTER_KEY_VERIFIER_KEY);
    if (row === undefined) {
      const legacyEnvelope = findFirstSensitiveEnvelope(sqlite);
      if (legacyEnvelope !== undefined) {
        decryptText(
          masterKey,
          legacyEnvelope.context,
          parseEncryptedValueEnvelope(legacyEnvelope.serializedEnvelope),
        );
      }
      writeMasterKeyVerifier(sqlite, masterKey);
      return;
    }

    const plaintext = decryptText(
      masterKey,
      masterKeyVerifierContext(),
      parseEncryptedValueEnvelope(row.valueJson),
    );
    if (plaintext !== MASTER_KEY_VERIFIER_PLAINTEXT) {
      throw new StorageCryptoError(
        "AUTHENTICATION_FAILED",
        "The Agent master key could not be authenticated.",
      );
    }
  })();
}

/** Removes only Agent-owned state and never touches Claude Code files or keys. */
export function resetAgentData(
  sqlite: BetterSqlite3.Database,
  confirmation: string,
): void {
  assertResetConfirmation(confirmation);

  sqlite.transaction(() => {
    sqlite.exec(`
      DELETE FROM event_overflow;
      DELETE FROM auth_challenges;
      DELETE FROM access_tokens;
      DELETE FROM operation_results;
      DELETE FROM device_credentials;
      DELETE FROM pairings;
      DELETE FROM audit_records;
      DELETE FROM tasks;
      DELETE FROM devices;
      DELETE FROM agent_settings;
    `);
  })();
}

/** Deletes expired retention data and never inspects Claude conversation data. */
export function pruneStorage(
  sqlite: BetterSqlite3.Database,
  now = Date.now(),
): StoragePruneResult {
  const accessTokens = sqlite
    .prepare("DELETE FROM access_tokens WHERE expires_at <= ?")
    .run(now).changes;
  const auditRecords = sqlite
    .prepare("DELETE FROM audit_records WHERE occurred_at < ?")
    .run(now - AUDIT_RETENTION_MILLISECONDS).changes;
  const expiredOperationResults = sqlite
    .prepare("DELETE FROM operation_results WHERE expires_at <= ?")
    .run(now).changes;
  const expiredPairings = sqlite
    .prepare("DELETE FROM pairings WHERE expires_at <= ?")
    .run(now).changes;

  const expiredAuthChallenges = sqlite
    .prepare("DELETE FROM auth_challenges WHERE expires_at <= ?")
    .run(now).changes;

  return {
    accessTokens,
    auditRecords,
    expiredAuthChallenges,
    expiredOperationResults,
    expiredPairings,
  };
}

/** Cleans transient replay overflow at process startup and after a turn ends. */
export function clearTransientEventOverflow(
  sqlite: BetterSqlite3.Database,
): number {
  return sqlite.prepare("DELETE FROM event_overflow").run().changes;
}

export function resetConfirmationValue(): string {
  return RESET_CONFIRMATION;
}

/** Rejects reset before callers acquire resources or mutate storage. */
export function assertResetConfirmation(confirmation: string): void {
  if (confirmation !== RESET_CONFIRMATION) {
    throw new StorageResetConfirmationError();
  }
}

function writeMasterKeyVerifier(
  sqlite: BetterSqlite3.Database,
  masterKey: Buffer,
): void {
  const envelope = encryptText(
    masterKey,
    masterKeyVerifierContext(),
    MASTER_KEY_VERIFIER_PLAINTEXT,
  );
  sqlite
    .prepare(
      `INSERT INTO agent_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(MASTER_KEY_VERIFIER_KEY, JSON.stringify(envelope), Date.now());
}

function masterKeyVerifierContext(): ReturnType<
  typeof createEncryptionContext
> {
  return createEncryptionContext({
    column: "value_json",
    recordId: MASTER_KEY_VERIFIER_KEY,
    table: "agent_settings",
  });
}

function findFirstSensitiveEnvelope(
  sqlite: BetterSqlite3.Database,
): SensitiveEnvelope | undefined {
  for (const encryptedColumn of encryptedColumns) {
    if (encryptedColumn.table === "event_overflow") {
      const event = sqlite
        .prepare<[], EventOverflowRow>(
          "SELECT task_id AS taskId, cursor, payload_envelope AS envelope FROM event_overflow LIMIT 1",
        )
        .get();
      if (event !== undefined) {
        return {
          context: createEncryptionContext({
            column: "payload_envelope",
            recordId: `${event.taskId}:${event.cursor}`,
            table: "event_overflow",
          }),
          serializedEnvelope: event.envelope,
        };
      }
      continue;
    }

    const record = sqlite
      .prepare<[], EncryptedRecordRow>(
        `SELECT id, ${encryptedColumn.column} AS envelope FROM ${encryptedColumn.table} LIMIT 1`,
      )
      .get();
    if (record !== undefined) {
      return {
        context: createEncryptionContext({
          column: encryptedColumn.column,
          recordId: record.id,
          table: encryptedColumn.table,
        }),
        serializedEnvelope: record.envelope,
      };
    }
  }
  return undefined;
}

function rekeyColumn(
  sqlite: BetterSqlite3.Database,
  encryptedColumn: EncryptedColumn,
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): number {
  if (encryptedColumn.table === "event_overflow") {
    return rekeyEventOverflow(sqlite, oldMasterKey, newMasterKey);
  }

  const records = sqlite
    .prepare<[], EncryptedRecordRow>(
      `SELECT id, ${encryptedColumn.column} AS envelope FROM ${encryptedColumn.table}`,
    )
    .all();
  const update = sqlite.prepare(
    `UPDATE ${encryptedColumn.table} SET ${encryptedColumn.column} = ? WHERE id = ?`,
  );

  for (const record of records) {
    const context = createEncryptionContext({
      column: encryptedColumn.column,
      recordId: record.id,
      table: encryptedColumn.table,
    });
    const plaintext = decryptText(
      oldMasterKey,
      context,
      parseEncryptedValueEnvelope(record.envelope),
    );
    const replacement = encryptText(newMasterKey, context, plaintext);
    update.run(JSON.stringify(replacement), record.id);
  }

  return records.length;
}

function rekeyEventOverflow(
  sqlite: BetterSqlite3.Database,
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): number {
  const records = sqlite
    .prepare<[], EventOverflowRow>(
      "SELECT task_id AS taskId, cursor, payload_envelope AS envelope FROM event_overflow",
    )
    .all();
  const update = sqlite.prepare(
    "UPDATE event_overflow SET payload_envelope = ? WHERE task_id = ? AND cursor = ?",
  );

  for (const record of records) {
    const context = createEncryptionContext({
      column: "payload_envelope",
      recordId: `${record.taskId}:${record.cursor}`,
      table: "event_overflow",
    });
    const plaintext = decryptText(
      oldMasterKey,
      context,
      parseEncryptedValueEnvelope(record.envelope),
    );
    const replacement = encryptText(newMasterKey, context, plaintext);
    update.run(JSON.stringify(replacement), record.taskId, record.cursor);
  }

  return records.length;
}
