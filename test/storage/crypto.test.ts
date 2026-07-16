import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createEncryptionContext,
  decryptText,
  encryptText,
  parseEncryptedValueEnvelope,
} from "../../src/storage/crypto.js";
import {
  MasterKeyError,
  StorageCryptoError,
} from "../../src/storage/errors.js";
import {
  AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE,
  AGENT_NEW_MASTER_KEY_ENVIRONMENT_VARIABLE,
  assertMasterKey,
  readAgentMasterKey,
  readNewAgentMasterKey,
} from "../../src/storage/master-key.js";

const context = createEncryptionContext({
  column: "secret_envelope",
  recordId: "credential-1",
  table: "device_credentials",
});

describe("storage encryption", () => {
  it("encrypts with authenticated table, column, and record context", () => {
    const masterKey = randomBytes(32);
    const envelope = encryptText(masterKey, context, "refresh-token-secret");

    expect(decryptText(masterKey, context, envelope)).toBe(
      "refresh-token-secret",
    );
    expect(() =>
      decryptText(
        masterKey,
        createEncryptionContext({
          column: "secret_envelope",
          recordId: "credential-2",
          table: "device_credentials",
        }),
        envelope,
      ),
    ).toThrow(StorageCryptoError);
  });

  it("rejects malformed and modified encrypted envelopes", () => {
    const masterKey = randomBytes(32);
    const envelope = encryptText(masterKey, context, "secret");
    const modifiedEnvelope = {
      ...envelope,
      tag: `${envelope.tag.slice(0, -1)}${
        envelope.tag.endsWith("A") ? "B" : "A"
      }`,
    };

    expect(() => decryptText(masterKey, context, modifiedEnvelope)).toThrow(
      StorageCryptoError,
    );
    expect(() => parseEncryptedValueEnvelope("not-json")).toThrow(
      StorageCryptoError,
    );
  });

  it("accepts only a complete 32-byte base64url environment key", () => {
    const key = randomBytes(32);
    const encodedKey = key.toString("base64url");

    expect(
      readAgentMasterKey({
        [AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE]: encodedKey,
      }),
    ).toEqual(key);
    expect(
      readNewAgentMasterKey({
        [AGENT_NEW_MASTER_KEY_ENVIRONMENT_VARIABLE]: encodedKey,
      }),
    ).toEqual(key);
    expect(() => readAgentMasterKey({})).toThrow(MasterKeyError);
    expect(() =>
      readAgentMasterKey({
        [AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE]: "not-a-32-byte-key",
      }),
    ).toThrow(MasterKeyError);
    expect(() => assertMasterKey(randomBytes(31))).toThrow(MasterKeyError);
  });
});
