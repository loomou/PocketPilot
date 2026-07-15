import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const tokenKinds = {
  access: "ppat",
  refresh: "pprt",
} as const;

const tokenIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenSecretPattern = /^[A-Za-z0-9_-]{43}$/;

export type OpaqueTokenKind = keyof typeof tokenKinds;

export type OpaqueToken = {
  id: string;
  secret: string;
  token: string;
  verifier: string;
};

export function createOpaqueToken(kind: OpaqueTokenKind): OpaqueToken {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");

  return {
    id,
    secret,
    token: `${tokenKinds[kind]}.${id}.${secret}`,
    verifier: tokenVerifier(secret),
  };
}

export function parseOpaqueToken(
  token: string,
  kind: OpaqueTokenKind,
): Pick<OpaqueToken, "id" | "secret"> | undefined {
  const [prefix, id, secret, ...remainder] = token.split(".");
  if (
    prefix !== tokenKinds[kind] ||
    id === undefined ||
    secret === undefined ||
    remainder.length !== 0 ||
    !tokenIdPattern.test(id) ||
    !tokenSecretPattern.test(secret)
  ) {
    return undefined;
  }

  return { id, secret };
}

export function tokenVerifier(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("base64url");
}

export function verifyTokenSecret(secret: string, verifier: string): boolean {
  const actual = Buffer.from(tokenVerifier(secret));
  const expected = Buffer.from(verifier);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
