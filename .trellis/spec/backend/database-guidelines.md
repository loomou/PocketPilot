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
tasks.origin: "pocketpilot" | "claude-session";
tasks.provider: string; // legacy/default: "claude"
tasks.native_protocol_version: string;
tasks.permission_mode: string | null;
tasks.sdk_session_id: string | null;
UNIQUE tasks(sdk_session_id)
  WHERE sdk_session_id IS NOT NULL AND state <> "terminal";
readAgentMasterKey(environment?): Buffer;
readNewAgentMasterKey(environment?): Buffer;
ensureMasterKeyVerifier(sqlite, masterKey): void;
rekeySensitiveData(sqlite, oldMasterKey, newMasterKey): number;
assertResetConfirmation(confirmation): void;
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
- `pnpm build` copies the complete `drizzle/` tree to `dist/drizzle`. A bundled
  CLI resolves that same-directory copy; source execution falls back to the
  repository `drizzle/` tree. The published package must contain SQL files,
  snapshots, and `meta/_journal.json` together.
- `AGENT_MASTER_KEY` is required only at secure runtime startup. It is exactly
  32 bytes represented as unpadded base64url (43 characters); reject missing,
  malformed, and non-32-byte values. Generate one with:

  ```powershell
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
  ```

- Secure startup creates or authenticates the encrypted
  `storage.master-key-verifier` row before pruning or binding listeners. This
  makes a later wrong-but-well-formed key fail even when no device credential
  happens to be available for authentication.

- Sensitive database fields use an AES-256-GCM envelope:
  `{ version: 1, algorithm, nonce, ciphertext, tag }`. Derive a key with
  HKDF-SHA-256 and authenticate JSON AAD containing the table, column, record
  ID, and envelope version. Never decrypt under a different record context.
- `rekeySensitiveData` validates both keys before work, authenticates the old
  key, decrypts and encrypts all known sensitive columns inside one SQLite
  transaction, replaces the key verifier, and rolls back on any
  malformed/tampered row. The CLI supplies the new key through the distinct
  `AGENT_NEW_MASTER_KEY` environment variable and rejects identical keys.
- `resetAgentData` requires the literal confirmation returned by
  `resetConfirmationValue()` and clears Agent-owned tables only. It never reads
  or deletes Claude files, configuration, credentials, or session JSONL.
- CLI reset calls `assertResetConfirmation()` before acquiring the data lock or
  opening SQLite, so an invalid confirmation cannot run migrations or perform
  any other storage write. Reset intentionally works without the old key.
- Delete event-overflow rows on startup and when an executing turn ends.
  Prune audit records after 30 days and expired operation/pairing, access-token,
  and challenge records by timestamp. Do not use these tables as transcript
  recovery.
- Device access/refresh credentials store only a SHA-256 verifier inside an
  AES-GCM envelope. The opaque plaintext token is never persisted. Retain
  superseded refresh credential verifiers until reset/device deletion so a
  verified reuse can revoke that device.
- Store non-secret settings only through `SettingsRepository` with a feature
  Zod schema on both write and read. Do not deserialize SQLite JSON with an
  unchecked cast.
- Task rows store runtime metadata only. Every task has an immutable provider
  ID and native protocol version. `claude-session` rows keep nullable SDK-owned
  startup controls and may persist the SDK session ID, but never a summary,
  prompt, message, tool payload, history page, or Claude settings object.
  Existing rows migrate to `provider = "claude"` and the pinned Claude Agent
  SDK protocol version without repurposing `sdkSessionId`.
- A partial unique index permits historical terminal rows but prevents two
  live runtime owners for one non-null SDK session ID. Before index creation,
  migration ranks duplicate non-terminal rows by `updated_at`, `created_at`,
  and `id`, keeps the newest, and terminalizes the rest. Generate the schema
  migration first, then review custom data-migration ordering before commit.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| `AGENT_MASTER_KEY` absent | `MasterKeyError` with `MASTER_KEY_MISSING`; secure runtime fails closed. |
| Key not 43-character unpadded base64url or not 32 bytes | `MasterKeyError` with `MASTER_KEY_INVALID`. |
| Persisted verifier does not authenticate | `StorageCryptoError` with `AUTHENTICATION_FAILED`; startup/rekey stops. |
| `AGENT_NEW_MASTER_KEY` missing or malformed | `MasterKeyError`; rekey makes no storage change. |
| Old and new rekey values are identical | `AgentMaintenanceError` with `MASTER_KEYS_IDENTICAL`. |
| Envelope malformed, version/algorithm unsupported | `StorageCryptoError` with `INVALID_ENVELOPE`. |
| Envelope/tag/context/key does not authenticate | `StorageCryptoError` with `AUTHENTICATION_FAILED`; do not expose crypto internals. |
| A rekeyed row cannot be parsed or authenticated | Throw and roll back every prior row update in that rekey transaction. |
| Reset confirmation differs from `RESET_AGENT_DATA` | `StorageResetConfirmationError`; make no changes. |
| Stored setting JSON is invalid or fails its Zod schema | `StorageDataError`; do not return the value. |
| Packaged migration journal is absent | Startup fails before binding listeners; release validation must reject the package. |
| Legacy tasks have no origin column | Migration writes `pocketpilot`; operation-result parsing also defaults missing legacy origin safely. |
| Legacy tasks have no provider metadata | Additive defaults expose them as Claude tasks with `@anthropic-ai/claude-agent-sdk@0.3.210`. |
| Duplicate non-terminal SDK session IDs exist | Keep the newest owner, terminalize older rows, then create the partial unique index. |
| Runtime attempts a second live owner | SQLite rejects the insert/update; return `CLAUDE_SESSION_CONFLICT` without starting another Query. |

### 5. Good / Base / Bad Cases

- Good: create a 32-byte key, encrypt a device refresh secret using
  `{ table: 'device_credentials', column: 'secret_envelope', recordId }`, then
  decrypt it with precisely the same context.
- Good: an attached task stores cwd, lifecycle, origin, and SDK session ID
  only; history is read from the SDK for each request and never reaches SQLite.
- Base: the first secure startup of a new database establishes its persistent
  key verifier before exposing either listener.
- Bad: encrypt one table row and copy its envelope to another record ID. AAD
  authentication must fail rather than treating the ciphertext as portable.

### 6. Tests Required

- Native SQLite smoke test opens a migrated file under Node 24 and confirms
  `foreign_keys` is enabled.
- Migration-test a legacy database with duplicate live SDK session owners;
  assert provider/protocol/origin backfill, only the newest remains
  non-terminal, and a later duplicate insert violates the partial unique index.
- Package inspection proves `dist/drizzle/meta/_journal.json` and every
  generated SQL migration ship with the built CLI. A fresh-storage built-CLI
  smoke test must complete migrations before listener startup.
- Settings test proves valid Zod data round-trips and corrupt JSON/schema data
  throws `StorageDataError`.
- Crypto test covers valid round-trip, altered ciphertext/tag, wrong context,
  malformed envelope, missing/invalid environment key, and wrong key length.
- Rekey test covers every encrypted table, successful new-key decrypt, old-key
  failure, verifier replacement, and full transaction rollback on one corrupt
  row.
- Retention/reset test covers 30-day audit cleanup, expired rows, temporary
  event deletion, rejected reset confirmation, and no remaining Agent rows
  after confirmed reset.
- Runtime maintenance tests prove invalid reset confirmation is rejected before
  storage opening and that reset remains possible when the old key is lost.

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
