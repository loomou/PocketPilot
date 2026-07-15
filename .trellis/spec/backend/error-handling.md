# Error Handling

## Overview

Errors are explicit typed boundaries. Constructors carry a stable code where a
caller must distinguish a corrective action; messages are safe for local logs
but must not contain keys, plaintext secrets, prompts, tool inputs, or model
output.

## Storage Error Types

| Type | Code | Use |
| --- | --- | --- |
| `MasterKeyError` | `MASTER_KEY_MISSING`, `MASTER_KEY_INVALID` | Missing or malformed runtime master key. |
| `StorageCryptoError` | `INVALID_ENVELOPE`, `AUTHENTICATION_FAILED` | Invalid encrypted data or failed AES-GCM authentication. |
| `StorageDataError` | none | Corrupt or schema-invalid non-secret setting JSON. |
| `StorageResetConfirmationError` | none | Reset requested without the exact explicit confirmation. |

## Patterns

- Validate external/environment data at the boundary, throw one of the typed
  errors, and let the future CLI/API layer translate it to a stable response.
- Catch crypto implementation failures inside the crypto module and replace
  them with `StorageCryptoError`; never return OpenSSL text to a caller.
- Preserve transaction errors from rekeying so SQLite rolls back; do not catch
  and continue to another encrypted row.
- Use Zod `safeParse` for persisted JSON and turn both parse and schema errors
  into `StorageDataError`.

## Common Mistakes

- Do not turn failed decryption into an absent credential. Authentication
  failure means the value is unusable and must stop the sensitive operation.
- Do not log an envelope's plaintext, the master key, a refresh credential, or
  raw setting JSON that could later contain a secret.
- Do not expose internal error messages directly through the remote API; that
  mapping belongs to the future validated API boundary.
