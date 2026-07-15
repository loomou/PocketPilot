import { createPublicKey, verify } from "node:crypto";

const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const publicKeyLength = 32;
const signatureLength = 64;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

export function normalizeDevicePublicKey(encoded: string): string | undefined {
  const publicKey = decodeBase64Url(encoded, publicKeyLength);
  return publicKey === undefined ? undefined : publicKey.toString("base64url");
}

export function verifyDeviceProof(
  encodedPublicKey: string,
  message: string,
  encodedSignature: string,
): boolean {
  const publicKey = decodeBase64Url(encodedPublicKey, publicKeyLength);
  const signature = decodeBase64Url(encodedSignature, signatureLength);
  if (publicKey === undefined || signature === undefined) {
    return false;
  }

  try {
    const key = createPublicKey({
      format: "der",
      key: Buffer.concat([ed25519SpkiPrefix, publicKey]),
      type: "spki",
    });
    return verify(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

function decodeBase64Url(
  encoded: string,
  expectedLength: number,
): Buffer | undefined {
  if (!base64UrlPattern.test(encoded)) {
    return undefined;
  }

  const decoded = Buffer.from(encoded, "base64url");
  return decoded.length === expectedLength &&
    decoded.toString("base64url") === encoded
    ? decoded
    : undefined;
}
