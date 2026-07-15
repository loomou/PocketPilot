import { MasterKeyError } from "./errors.js";

export const AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE = "AGENT_MASTER_KEY";

const masterKeyPattern = /^[A-Za-z0-9_-]{43}$/;

/**
 * Reads the 32-byte Agent master key from unpadded base64url.
 *
 * A fixed textual representation prevents platform-dependent secret handling
 * and makes accidental truncation or encoding conversion fail closed.
 */
export function readAgentMasterKey(
  environment: NodeJS.ProcessEnv = process.env,
): Buffer {
  const encoded = environment[AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE];
  if (encoded === undefined || encoded.length === 0) {
    throw new MasterKeyError(
      "MASTER_KEY_MISSING",
      `${AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE} must contain a 32-byte base64url key.`,
    );
  }

  if (!masterKeyPattern.test(encoded)) {
    throw new MasterKeyError(
      "MASTER_KEY_INVALID",
      `${AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE} must be an unpadded base64url-encoded 32-byte key.`,
    );
  }

  const key = Buffer.from(encoded, "base64url");
  if (key.toString("base64url") !== encoded) {
    throw new MasterKeyError(
      "MASTER_KEY_INVALID",
      `${AGENT_MASTER_KEY_ENVIRONMENT_VARIABLE} must be an unpadded base64url-encoded 32-byte key.`,
    );
  }

  return assertMasterKey(key);
}

export function assertMasterKey(masterKey: Uint8Array): Buffer {
  if (masterKey.length !== 32) {
    throw new MasterKeyError(
      "MASTER_KEY_INVALID",
      "The Agent master key must be exactly 32 bytes.",
    );
  }

  return Buffer.from(masterKey);
}
