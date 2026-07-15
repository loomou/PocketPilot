# Database Guidelines

## Scenario: Agent-Owned SQLite Persistence and Encryption

### 1. Scope / Trigger

Apply this contract when code creates or migrates the Agent SQLite database,
stores Agent-managed settings or credentials, rekeys encrypted data, or removes
temporary/restricted-retention rows.

PocketPilot stores Agent metadata only. Claude conversation transcripts,
Claude configuration, and API keys do not belong in these tables.

### 2. Signatures

```ts
openStorage({ databasePath, migrationsFolder? }): StorageConnection;
readAgentMasterKey(environment?): Buffer;
rekeySensitiveData(sqlite, oldMasterKey, newMasterKey): number;
resetAgentData(sqlite, confirmation): void;
pruneStorage(sqlite, now?): StoragePruneResult;
```

Drizzle schema lives in `src/storage/schema.ts`; generated SQL and metadata
live in `drizzle/`. Runtime migration uses
`drizzle-orm/better-sqlite3/migrator` after opening the database.

### 3. Contracts

- Use `better-sqlite3` for direct, synchronous SQLite transactions and Drizzle
  for schema/query ownership. `openStorage` enables `foreign_keys` and WAL.
- Generate schema changes with `pnpm exec drizzle-kit generate`; commit the
  schema, SQL migration, and Drizzle metadata in the same change.
- `AGENT_MASTER_KEY` is required only at secure runtime startup. It is exactly
  32 bytes represented as unpadded base64url (43 characters); reject missing,
  malformed, and non-32-byte values. Generate one with:

  ```powershell
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
  ```

- Sensitive database fields use an AES-256-GCM envelope:
  `{ version: 1, algorithm, nonce, ciphertext, tag }`. Derive a key with
  HKDF-SHA-256 and authenticate JSON AAD containing the table, column, record
  ID, and envelope version. Never decrypt under a different record context.
- `rekeySensitiveData` validates both keys before work, decrypts and encrypts
  all known sensitive columns inside one SQLite transaction, and rolls back on
  any malformed/tampered row.
- `resetAgentData` requires the literal confirmation returned by
  `resetConfirmationValue()` and clears Agent-owned tables only. It never reads
  or deletes Claude files, configuration, credentials, or session JSONL.
- Delete event-overflow rows on startup and when an executing turn ends.
  Prune audit records after 30 days and expired operation/pairing records by
  timestamp. Do not use these tables as transcript recovery.
- Store non-secret settings only through `SettingsRepository` with a feature
  Zod schema on both write and read. Do not deserialize SQLite JSON with an
  unchecked cast.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| `AGENT_MASTER_KEY` absent | `MasterKeyError` with `MASTER_KEY_MISSING`; secure runtime fails closed. |
| Key not 43-character unpadded base64url or not 32 bytes | `MasterKeyError` with `MASTER_KEY_INVALID`. |
| Envelope malformed, version/algorithm unsupported | `StorageCryptoError` with `INVALID_ENVELOPE`. |
| Envelope/tag/context/key does not authenticate | `StorageCryptoError` with `AUTHENTICATION_FAILED`; do not expose crypto internals. |
| A rekeyed row cannot be parsed or authenticated | Throw and roll back every prior row update in that rekey transaction. |
| Reset confirmation differs from `RESET_AGENT_DATA` | `StorageResetConfirmationError`; make no changes. |
| Stored setting JSON is invalid or fails its Zod schema | `StorageDataError`; do not return the value. |

### 5. Good / Base / Bad Cases

- Good: create a 32-byte key, encrypt a device refresh secret using
  `{ table: 'device_credentials', column: 'secret_envelope', recordId }`, then
  decrypt it with precisely the same context.
- Base: a new database contains only migration metadata and no settings or
  sensitive rows; rekey still validates both supplied master keys.
- Bad: encrypt one table row and copy its envelope to another record ID. AAD
  authentication must fail rather than treating the ciphertext as portable.

### 6. Tests Required

- Native SQLite smoke test opens a migrated file under Node 24 and confirms
  `foreign_keys` is enabled.
- Settings test proves valid Zod data round-trips and corrupt JSON/schema data
  throws `StorageDataError`.
- Crypto test covers valid round-trip, altered ciphertext/tag, wrong context,
  malformed envelope, missing/invalid environment key, and wrong key length.
- Rekey test covers every encrypted table, successful new-key decrypt, old-key
  failure, and full transaction rollback on one corrupt row.
- Retention/reset test covers 30-day audit cleanup, expired rows, temporary
  event deletion, rejected reset confirmation, and no remaining Agent rows
  after confirmed reset.

### 7. Wrong vs Correct

#### Wrong

```ts
const token = JSON.parse(row.secret_envelope) as { token: string };
database.prepare("UPDATE device_credentials SET token = ?").run(token.token);
```

This stores plaintext and trusts unvalidated SQLite JSON.

#### Correct

```ts
const envelope = encryptText(masterKey, {
  table: "device_credentials",
  column: "secret_envelope",
  recordId: credentialId,
}, refreshSecret);

database.prepare("UPDATE device_credentials SET secret_envelope = ? WHERE id = ?")
  .run(JSON.stringify(envelope), credentialId);
```

The corresponding reader parses the envelope through the shared validator and
uses the same AAD context to authenticate before it sees plaintext.
