import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { StorageCryptoError } from "./errors.js";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_VERSION = 1;
const HKDF_SALT = Buffer.from("pocketpilot:storage:v1", "utf8");
const NONCE_LENGTH_BYTES = 12;
const AUTHENTICATION_TAG_LENGTH_BYTES = 16;
const base64UrlPattern = /^[A-Za-z0-9_-]*$/;

export type EncryptedValueEnvelope = {
  algorithm: "aes-256-gcm";
  ciphertext: string;
  nonce: string;
  tag: string;
  version: 1;
};

export type EncryptionContext = {
  column: string;
  recordId: string;
  table: string;
};

export function createEncryptionContext(
  context: EncryptionContext,
): EncryptionContext {
  for (const value of Object.values(context)) {
    if (value.length === 0) {
      throw new StorageCryptoError(
        "INVALID_ENVELOPE",
        "Encryption context values must not be empty.",
      );
    }
  }

  return context;
}

export function encryptValue(
  masterKey: Buffer,
  context: EncryptionContext,
  plaintext: Uint8Array,
): EncryptedValueEnvelope {
  const additionalData = encodeAdditionalData(context);
  const nonce = randomBytes(NONCE_LENGTH_BYTES);
  const cipher = createCipheriv(
    ENCRYPTION_ALGORITHM,
    deriveEncryptionKey(masterKey, additionalData),
    nonce,
    { authTagLength: AUTHENTICATION_TAG_LENGTH_BYTES },
  );
  cipher.setAAD(additionalData);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    algorithm: ENCRYPTION_ALGORITHM,
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    version: ENCRYPTION_VERSION,
  };
}

export function decryptValue(
  masterKey: Buffer,
  context: EncryptionContext,
  envelope: EncryptedValueEnvelope,
): Buffer {
  const additionalData = encodeAdditionalData(context);
  validateEnvelope(envelope);

  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      deriveEncryptionKey(masterKey, additionalData),
      decodeBase64Url(envelope.nonce, NONCE_LENGTH_BYTES),
      { authTagLength: AUTHENTICATION_TAG_LENGTH_BYTES },
    );
    decipher.setAAD(additionalData);
    decipher.setAuthTag(
      decodeBase64Url(envelope.tag, AUTHENTICATION_TAG_LENGTH_BYTES),
    );

    return Buffer.concat([
      decipher.update(decodeBase64Url(envelope.ciphertext)),
      decipher.final(),
    ]);
  } catch {
    throw new StorageCryptoError(
      "AUTHENTICATION_FAILED",
      "The encrypted storage value could not be authenticated.",
    );
  }
}

export function encryptText(
  masterKey: Buffer,
  context: EncryptionContext,
  plaintext: string,
): EncryptedValueEnvelope {
  return encryptValue(masterKey, context, Buffer.from(plaintext, "utf8"));
}

export function decryptText(
  masterKey: Buffer,
  context: EncryptionContext,
  envelope: EncryptedValueEnvelope,
): string {
  return decryptValue(masterKey, context, envelope).toString("utf8");
}

export function parseEncryptedValueEnvelope(
  serializedEnvelope: string,
): EncryptedValueEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedEnvelope);
  } catch {
    throw new StorageCryptoError(
      "INVALID_ENVELOPE",
      "The encrypted storage value is not valid JSON.",
    );
  }

  if (!isEncryptedValueEnvelope(parsed)) {
    throw new StorageCryptoError(
      "INVALID_ENVELOPE",
      "The encrypted storage value has an invalid envelope shape.",
    );
  }

  return parsed;
}

function decodeBase64Url(value: string, expectedLength?: number): Buffer {
  if (!base64UrlPattern.test(value)) {
    throw new StorageCryptoError(
      "INVALID_ENVELOPE",
      "The encrypted storage value has invalid base64url data.",
    );
  }

  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedLength !== undefined && decoded.length !== expectedLength)
  ) {
    throw new StorageCryptoError(
      "INVALID_ENVELOPE",
      "The encrypted storage value has invalid binary field lengths.",
    );
  }

  return decoded;
}

function deriveEncryptionKey(
  masterKey: Buffer,
  additionalData: Buffer,
): Buffer {
  if (masterKey.length !== 32) {
    throw new StorageCryptoError(
      "INVALID_ENVELOPE",
      "The storage master key must be exactly 32 bytes.",
    );
  }

  return Buffer.from(
    hkdfSync("sha256", masterKey, HKDF_SALT, additionalData, 32),
  );
}

function encodeAdditionalData(context: EncryptionContext): Buffer {
  const validatedContext = createEncryptionContext(context);
  return Buffer.from(
    JSON.stringify({
      column: validatedContext.column,
      recordId: validatedContext.recordId,
      table: validatedContext.table,
      version: ENCRYPTION_VERSION,
    }),
    "utf8",
  );
}

function validateEnvelope(envelope: EncryptedValueEnvelope): void {
  if (
    envelope.algorithm !== ENCRYPTION_ALGORITHM ||
    envelope.version !== ENCRYPTION_VERSION
  ) {
    throw new StorageCryptoError(
      "INVALID_ENVELOPE",
      "The encrypted storage value uses an unsupported envelope version.",
    );
  }
}

function isEncryptedValueEnvelope(
  value: unknown,
): value is EncryptedValueEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const envelope = Object.fromEntries(Object.entries(value));
  return (
    envelope.algorithm === "aes-256-gcm" &&
    typeof envelope.ciphertext === "string" &&
    typeof envelope.nonce === "string" &&
    typeof envelope.tag === "string" &&
    envelope.version === 1
  );
}
