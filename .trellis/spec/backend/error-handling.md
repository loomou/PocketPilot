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
| `RuntimeControlError` | `RUNTIME_NOT_RUNNING`, `RUNTIME_STATE_INVALID`, `RUNTIME_CONTROL_UNAVAILABLE`, `RUNTIME_CONTROL_REJECTED` | Local `agent stop` control-state or loopback shutdown failure. |
| `AgentMaintenanceError` | `AGENT_DATA_NOT_FOUND`, `AGENT_MAINTENANCE_LOCKED`, `AGENT_MAINTENANCE_LOCK_UNAVAILABLE`, `MASTER_KEYS_IDENTICAL` | Stopped-only maintenance preconditions and exclusive data-lock failures. |
| `EnvironmentConfigurationError` | `DOTENV_READ_FAILED`, `ENVIRONMENT_VALUE_INVALID` | Safe startup-directory dotenv read and allowlisted value validation failures. |
| `DeviceAuthError` | Pairing, device-proof, challenge, opaque-token, and revocation codes | HTTP-safe device authentication failure. |
| `TaskError` | Task lifecycle/policy codes plus `CLAUDE_SESSION_NOT_FOUND`, `CLAUDE_SESSION_CONFLICT`, `CLAUDE_HISTORY_UNAVAILABLE`, and `HISTORY_CURSOR_STALE` | Validated mobile task, SDK-session, history, and control failures. |
| `LocalAdminError` | Directory picker/selection/authorization management codes | HTTP-safe loopback directory-management failures. |

## Patterns

- Validate external/environment data at the boundary, throw one of the typed
  errors, and let the future CLI/API layer translate it to a stable response.
- Dotenv errors may identify the supported key or the startup `.env` boundary,
  but never include file contents, parsed values, or a secret-bearing source
  line.
- Catch crypto implementation failures inside the crypto module and replace
  them with `StorageCryptoError`; never return OpenSSL text to a caller.
- Preserve transaction errors from rekeying so SQLite rolls back; do not catch
  and continue to another encrypted row.
- Use Zod `safeParse` for persisted JSON and turn both parse and schema errors
  into `StorageDataError`.
- Translate malformed/missing runtime-control state and loopback stop failures
  into `RuntimeControlError`; never surface raw `fetch`/socket text from a
  local command.
- Translate expected data-lock and maintenance precondition failures into
  `AgentMaintenanceError`; do not surface filesystem/lock-library details.
- Translate expected pairing/authentication failure into `DeviceAuthError` and
  let the Fastify boundary return only `{ code, message }`; never leak token,
  verifier, signature, or crypto-library details.
- Keep task errors metadata-only: do not put an instruction, model output, tool
  input, or SDK process details in a `TaskError` message.
- Scoped authorized-directory routes preserve Fastify validation errors, map
  `LocalAdminError`/`TaskError` to their stable status/code, and map every other
  failure to `500 LOCAL_ADMIN_OPERATION_FAILED`. Never return raw PowerShell,
  filesystem, SQLite, or SDK exception text from this surface.
- Map missing/out-of-policy session metadata to the same safe
  `CLAUDE_SESSION_NOT_FOUND` response. Map transcript parse/read failure to
  retryable `CLAUDE_HISTORY_UNAVAILABLE` and a disappeared UUID anchor to
  `HISTORY_CURSOR_STALE`; never include a summary, prompt, message, raw SDK
  error, or machine path in these responses.
- The provider-native Agent WebSocket never sends PocketPilot error JSON.
  Translate invalid input, authentication, missing task, unavailable session,
  and unexpected transport failure to stable close code/reason pairs `4000`,
  `4003`, `4004`,
  `4009`, and `4011`. Use `SDK_MESSAGE_INVALID`, `TASK_NOT_FOUND`,
  `TASK_SESSION_UNAVAILABLE`, and `SDK_TRANSPORT_FAILED` as stable reasons on
  the provider-native Agent socket; never use raw SDK input or exception text as
  a close reason.

## Common Mistakes

- Do not turn failed decryption into an absent credential. Authentication
  failure means the value is unusable and must stop the sensitive operation.
- Do not log an envelope's plaintext, the master key, a refresh credential, or
  raw setting JSON that could later contain a secret.
- Do not expose internal error messages directly through the remote API; that
  mapping belongs to the future validated API boundary.
- Do not use `reply.send(error)` for an unknown authorized-directory failure;
  only schema-validation errors may retain Fastify's normal 400 translation.
- Do not delete a runtime-control file merely because a new startup failed;
  only the runtime that owns its random control token may remove it.
- Do not open SQLite for reset until the literal confirmation has been
  validated, and do not let rekey/reset proceed without the shared data lock.
- A verified refresh-token reuse is a security event, not a normal invalid
  token: revoke the device and close its registered sockets before responding.
