import type BetterSqlite3 from "better-sqlite3";

import {
  createEncryptionContext,
  decryptText,
  encryptText,
  parseEncryptedValueEnvelope,
} from "./crypto.js";
import { StorageResetConfirmationError } from "./errors.js";
import { assertMasterKey } from "./master-key.js";

const AUDIT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const RESET_CONFIRMATION = "RESET_AGENT_DATA";

type EncryptedColumn =
  | {
      column: "secret_envelope";
      table: "device_credentials" | "pairings";
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

const encryptedColumns: readonly EncryptedColumn[] = [
  { column: "secret_envelope", table: "device_credentials" },
  { column: "secret_envelope", table: "pairings" },
  { column: "payload_envelope", table: "event_overflow" },
];

export type StoragePruneResult = {
  auditRecords: number;
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
    let migrated = 0;
    for (const encryptedColumn of encryptedColumns) {
      migrated += rekeyColumn(
        sqlite,
        encryptedColumn,
        oldMasterKey,
        newMasterKey,
      );
    }
    return migrated;
  })();
}

/** Removes only Agent-owned state and never touches Claude Code files or keys. */
export function resetAgentData(
  sqlite: BetterSqlite3.Database,
  confirmation: string,
): void {
  if (confirmation !== RESET_CONFIRMATION) {
    throw new StorageResetConfirmationError();
  }

  sqlite.transaction(() => {
    sqlite.exec(`
      DELETE FROM event_overflow;
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
  const auditRecords = sqlite
    .prepare("DELETE FROM audit_records WHERE occurred_at < ?")
    .run(now - AUDIT_RETENTION_MILLISECONDS).changes;
  const expiredOperationResults = sqlite
    .prepare("DELETE FROM operation_results WHERE expires_at < ?")
    .run(now).changes;
  const expiredPairings = sqlite
    .prepare("DELETE FROM pairings WHERE expires_at < ?")
    .run(now).changes;

  return { auditRecords, expiredOperationResults, expiredPairings };
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
