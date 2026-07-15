import {
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import { readRuntimeSettings } from "../runtime/settings.js";
import {
  createEncryptionContext,
  decryptText,
  encryptText,
  parseEncryptedValueEnvelope,
} from "../storage/crypto.js";
import { StorageDataError } from "../storage/errors.js";
import type { SettingsRepository } from "../storage/settings-repository.js";
import { normalizeDevicePublicKey, verifyDeviceProof } from "./device-proof.js";
import { DeviceAuthError } from "./errors.js";
import {
  createOpaqueToken,
  parseOpaqueToken,
  verifyTokenSecret,
} from "./opaque-token.js";

const ACCESS_TOKEN_LIFETIME_MILLISECONDS = 60 * 60 * 1000;
const AGENT_IDENTITY_SETTINGS_KEY = "auth.agent-identity";
const CHALLENGE_LIFETIME_MILLISECONDS = 5 * 60 * 1000;
const PAIRING_LIFETIME_MILLISECONDS = 5 * 60 * 1000;
const REFRESH_INACTIVITY_LIFETIME_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

const agentIdentitySettingsSchema = z.object({
  agentId: z.uuid(),
});

const pairingSecretSchema = z.object({
  verificationCode: z
    .string()
    .regex(/^\d{6}$/)
    .nullable(),
});

type ChallengePurpose = "pairing_claim" | "refresh";

type PairingRow = {
  approvedAt: number | null;
  credentialClaimedAt: number | null;
  createdAt: number;
  deviceDisplayName: string | null;
  deviceId: string | null;
  devicePublicKey: string | null;
  expiresAt: number;
  id: string;
  secretEnvelope: string;
  usedAt: number | null;
};

type DeviceRow = {
  createdAt: number;
  displayName: string;
  id: string;
  publicKey: string;
  revokedAt: number | null;
};

type RefreshCredentialRow = {
  createdAt: number;
  deviceCreatedAt: number;
  deviceDisplayName: string;
  deviceId: string;
  devicePublicKey: string;
  deviceRevokedAt: number | null;
  id: string;
  lastUsedAt: number;
  secretEnvelope: string;
  supersededAt: number | null;
};

type AccessTokenRow = {
  deviceCreatedAt: number;
  deviceDisplayName: string;
  deviceId: string;
  devicePublicKey: string;
  deviceRevokedAt: number | null;
  expiresAt: number;
  id: string;
  revokedAt: number | null;
  secretEnvelope: string;
};

type ChallengeRow = {
  createdAt: number;
  deviceId: string | null;
  expiresAt: number;
  id: string;
  nonce: string;
  pairingId: string | null;
  purpose: string;
  usedAt: number | null;
};

export type DeviceConnectionRegistry = {
  closeDeviceConnections(deviceId: string): void;
};

export type DeviceAuthServiceOptions = {
  closeDeviceConnections?: DeviceConnectionRegistry;
  masterKey: Buffer;
  now?: () => number;
  settingsRepository: SettingsRepository;
  sqlite: BetterSqlite3.Database;
};

export type PairingQrPayload = {
  agentId: string;
  baseUrl: string;
  expiresAt: number;
  pairingId: string;
  version: 1;
};

export type CreatedPairing = {
  expiresAt: number;
  pairingId: string;
  qrPayload: PairingQrPayload;
};

export type PendingPairing = {
  deviceDisplayName: string;
  expiresAt: number;
  pairingId: string;
  verificationCode: string;
};

export type PairedDevice = {
  createdAt: number;
  displayName: string;
  id: string;
  revokedAt: number | null;
};

export type DeviceChallenge = {
  challengeId: string;
  expiresAt: number;
  message: string;
  nonce: string;
};

export type IssuedDeviceCredentials = {
  accessExpiresAt: number;
  accessToken: string;
  refreshToken: string;
};

export type AuthenticatedDevice = PairedDevice;

/**
 * Owns pairing, device proof, opaque credential rotation, and device revocation.
 * Plaintext refresh and access credentials exist only in the response that
 * issues them; SQLite keeps encrypted SHA-256 verifiers instead.
 */
export class DeviceAuthService {
  private readonly closeDeviceConnections: DeviceConnectionRegistry;
  private readonly now: () => number;

  public constructor(private readonly options: DeviceAuthServiceOptions) {
    this.closeDeviceConnections = options.closeDeviceConnections ?? {
      closeDeviceConnections: () => undefined,
    };
    this.now = options.now ?? Date.now;
  }

  public createPairing(): CreatedPairing {
    const runtimeSettings = readRuntimeSettings(
      this.options.settingsRepository,
    );
    if (runtimeSettings.mobileBaseUrl === undefined) {
      throw new DeviceAuthError(
        "MOBILE_BASE_URL_NOT_CONFIGURED",
        409,
        "A mobile-reachable base URL must be configured before pairing a device.",
      );
    }

    const pairingId = randomUUID();
    const createdAt = this.now();
    const expiresAt = createdAt + PAIRING_LIFETIME_MILLISECONDS;
    const agentId = this.getAgentId();
    this.options.sqlite
      .prepare(
        "INSERT INTO pairings (id, created_at, expires_at, secret_envelope) VALUES (?, ?, ?, ?)",
      )
      .run(
        pairingId,
        createdAt,
        expiresAt,
        this.encryptPairingSecret(pairingId, { verificationCode: null }),
      );

    return {
      expiresAt,
      pairingId,
      qrPayload: {
        agentId,
        baseUrl: runtimeSettings.mobileBaseUrl,
        expiresAt,
        pairingId,
        version: 1,
      },
    };
  }

  public registerPairingDevice(input: {
    deviceDisplayName: string;
    devicePublicKey: string;
    pairingId: string;
  }): { expiresAt: number; pairingId: string; verificationCode: string } {
    const publicKey = normalizeDevicePublicKey(input.devicePublicKey);
    if (publicKey === undefined) {
      throw new DeviceAuthError(
        "DEVICE_PUBLIC_KEY_INVALID",
        409,
        "The device public key must be a 32-byte Ed25519 base64url value.",
      );
    }

    const now = this.now();
    return this.options.sqlite.transaction(() => {
      const pairing = this.getPairing(input.pairingId);
      this.assertPairingAvailableForRegistration(pairing, now);

      const verificationCode = randomInt(0, 1_000_000)
        .toString()
        .padStart(6, "0");
      const updated = this.options.sqlite
        .prepare(
          `UPDATE pairings
           SET device_display_name = ?, device_public_key = ?, secret_envelope = ?, used_at = ?
           WHERE id = ? AND used_at IS NULL AND device_id IS NULL`,
        )
        .run(
          input.deviceDisplayName,
          publicKey,
          this.encryptPairingSecret(input.pairingId, { verificationCode }),
          now,
          input.pairingId,
        );
      if (updated.changes !== 1) {
        throw pairingAlreadyUsedError();
      }

      return {
        expiresAt: pairing.expiresAt,
        pairingId: pairing.id,
        verificationCode,
      };
    })();
  }

  public listPendingPairings(): PendingPairing[] {
    const now = this.now();
    const rows = this.options.sqlite
      .prepare<[number], PairingRow>(
        `SELECT approved_at AS approvedAt, created_at AS createdAt,
                credential_claimed_at AS credentialClaimedAt,
                device_display_name AS deviceDisplayName, device_id AS deviceId,
                device_public_key AS devicePublicKey, expires_at AS expiresAt,
                id, secret_envelope AS secretEnvelope, used_at AS usedAt
         FROM pairings
         WHERE used_at IS NOT NULL AND approved_at IS NULL AND expires_at > ?
         ORDER BY used_at ASC`,
      )
      .all(now);

    return rows.flatMap((pairing) => {
      if (pairing.deviceDisplayName === null || pairing.deviceId !== null) {
        return [];
      }
      const { verificationCode } = this.decryptPairingSecret(pairing);
      return verificationCode === null
        ? []
        : [
            {
              deviceDisplayName: pairing.deviceDisplayName,
              expiresAt: pairing.expiresAt,
              pairingId: pairing.id,
              verificationCode,
            },
          ];
    });
  }

  public approvePairing(input: {
    pairingId: string;
    verificationCode: string;
  }): PairedDevice {
    const now = this.now();
    return this.options.sqlite.transaction(() => {
      const pairing = this.getPairing(input.pairingId);
      this.assertPairingPendingApproval(pairing, now);
      const pairingSecret = this.decryptPairingSecret(pairing);
      if (
        pairingSecret.verificationCode === null ||
        !constantTimeEquals(
          input.verificationCode,
          pairingSecret.verificationCode,
        )
      ) {
        throw new DeviceAuthError(
          "PAIRING_VERIFICATION_CODE_MISMATCH",
          409,
          "The pairing verification code does not match the pending device.",
        );
      }
      if (
        pairing.deviceDisplayName === null ||
        pairing.devicePublicKey === null
      ) {
        throw new DeviceAuthError(
          "PAIRING_NOT_PENDING",
          409,
          "The pairing has no pending device registration.",
        );
      }

      const device: PairedDevice = {
        createdAt: now,
        displayName: pairing.deviceDisplayName,
        id: randomUUID(),
        revokedAt: null,
      };
      this.options.sqlite
        .prepare(
          "INSERT INTO devices (id, display_name, public_key, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(device.id, device.displayName, pairing.devicePublicKey, now);
      const updated = this.options.sqlite
        .prepare(
          "UPDATE pairings SET device_id = ?, approved_at = ? WHERE id = ? AND device_id IS NULL AND approved_at IS NULL",
        )
        .run(device.id, now, pairing.id);
      if (updated.changes !== 1) {
        throw new DeviceAuthError(
          "PAIRING_NOT_PENDING",
          409,
          "The pairing is no longer awaiting local approval.",
        );
      }

      return device;
    })();
  }

  public createPairingClaimChallenge(pairingId: string): DeviceChallenge {
    const pairing = this.getPairing(pairingId);
    const now = this.now();
    this.assertPairingApproved(pairing, now);
    return this.createChallenge({
      deviceId: pairing.deviceId,
      pairingId,
      purpose: "pairing_claim",
    });
  }

  public async claimPairingCredentials(input: {
    challengeId: string;
    pairingId: string;
    signature: string;
  }): Promise<IssuedDeviceCredentials> {
    const pairing = this.getPairing(input.pairingId);
    const now = this.now();
    this.assertPairingApproved(pairing, now);
    const device = this.getDevice(pairing.deviceId);
    this.assertDeviceActive(device);
    await this.verifyChallengeProof({
      challengeId: input.challengeId,
      device,
      pairingId: input.pairingId,
      purpose: "pairing_claim",
      signature: input.signature,
    });

    return this.options.sqlite.transaction(() => {
      this.consumeChallenge(input.challengeId, now);
      const currentPairing = this.getPairing(input.pairingId);
      if (currentPairing.credentialClaimedAt !== null) {
        this.options.sqlite
          .prepare(
            "UPDATE device_credentials SET superseded_at = ? WHERE device_id = ? AND superseded_at IS NULL",
          )
          .run(now, device.id);
        this.options.sqlite
          .prepare(
            "UPDATE access_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
          )
          .run(now, device.id);
      }
      const claimed = this.options.sqlite
        .prepare("UPDATE pairings SET credential_claimed_at = ? WHERE id = ?")
        .run(now, input.pairingId);
      if (claimed.changes !== 1) {
        throw new DeviceAuthError(
          "PAIRING_NOT_FOUND",
          404,
          "The pairing request was not found.",
        );
      }
      return this.issueCredentials(device.id, now);
    })();
  }

  public createRefreshChallenge(deviceId: string): DeviceChallenge {
    const device = this.getDevice(deviceId);
    this.assertDeviceActive(device);
    return this.createChallenge({ deviceId, purpose: "refresh" });
  }

  public async refreshCredentials(input: {
    challengeId: string;
    refreshToken: string;
    signature: string;
  }): Promise<IssuedDeviceCredentials> {
    const parsedToken = parseOpaqueToken(input.refreshToken, "refresh");
    if (parsedToken === undefined) {
      throw refreshTokenInvalidError();
    }
    const credential = this.getRefreshCredential(parsedToken.id);
    if (credential === undefined) {
      throw refreshTokenInvalidError();
    }
    if (
      !this.verifyStoredToken(parsedToken.secret, credential.secretEnvelope, {
        column: "secret_envelope",
        recordId: credential.id,
        table: "device_credentials",
      })
    ) {
      throw refreshTokenInvalidError();
    }

    const device: DeviceRow = {
      createdAt: credential.deviceCreatedAt,
      displayName: credential.deviceDisplayName,
      id: credential.deviceId,
      publicKey: credential.devicePublicKey,
      revokedAt: credential.deviceRevokedAt,
    };
    this.assertDeviceActive(device);
    await this.verifyChallengeProof({
      challengeId: input.challengeId,
      device,
      purpose: "refresh",
      signature: input.signature,
    });

    const now = this.now();
    const rotation = this.options.sqlite.transaction(() => {
      this.consumeChallenge(input.challengeId, now);
      return this.rotateRefreshCredential(
        credential.id,
        credential.deviceId,
        now,
      );
    })();
    if (rotation.kind !== "issued") {
      if (rotation.kind === "reused") {
        this.closeDeviceConnections.closeDeviceConnections(credential.deviceId);
        throw new DeviceAuthError(
          "REFRESH_TOKEN_REUSED",
          401,
          "The refresh credential was reused and the device session was revoked.",
        );
      }
      throw new DeviceAuthError(
        "REFRESH_TOKEN_EXPIRED",
        401,
        "The refresh credential expired after inactivity. Pair the device again.",
      );
    }

    return rotation.credentials;
  }

  public authenticateAccessToken(accessToken: string): AuthenticatedDevice {
    const parsedToken = parseOpaqueToken(accessToken, "access");
    if (parsedToken === undefined) {
      throw accessTokenInvalidError();
    }
    const token = this.getAccessToken(parsedToken.id);
    if (token === undefined) {
      throw accessTokenInvalidError();
    }
    if (
      !this.verifyStoredToken(parsedToken.secret, token.secretEnvelope, {
        column: "secret_envelope",
        recordId: token.id,
        table: "access_tokens",
      })
    ) {
      throw accessTokenInvalidError();
    }
    if (token.deviceRevokedAt !== null || token.revokedAt !== null) {
      throw new DeviceAuthError(
        "ACCESS_TOKEN_REVOKED",
        401,
        "The access credential belongs to a revoked device.",
      );
    }
    if (token.expiresAt <= this.now()) {
      throw new DeviceAuthError(
        "ACCESS_TOKEN_EXPIRED",
        401,
        "The access credential has expired.",
      );
    }

    return {
      createdAt: token.deviceCreatedAt,
      displayName: token.deviceDisplayName,
      id: token.deviceId,
      revokedAt: token.deviceRevokedAt,
    };
  }

  public listDevices(): PairedDevice[] {
    return this.options.sqlite
      .prepare<[], PairedDevice>(
        "SELECT created_at AS createdAt, display_name AS displayName, id, revoked_at AS revokedAt FROM devices ORDER BY created_at ASC",
      )
      .all();
  }

  public revokeDevice(deviceId: string): boolean {
    const now = this.now();
    const changed = this.options.sqlite.transaction(() => {
      const update = this.options.sqlite
        .prepare(
          "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(now, deviceId);
      if (update.changes === 1) {
        this.options.sqlite
          .prepare(
            "UPDATE access_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
          )
          .run(now, deviceId);
      }
      return update.changes === 1;
    })();
    if (changed) {
      this.closeDeviceConnections.closeDeviceConnections(deviceId);
    }
    return changed;
  }

  private createChallenge(input: {
    deviceId: string;
    pairingId?: string;
    purpose: ChallengePurpose;
  }): DeviceChallenge {
    const createdAt = this.now();
    const challenge: ChallengeRow = {
      createdAt,
      deviceId: input.deviceId,
      expiresAt: createdAt + CHALLENGE_LIFETIME_MILLISECONDS,
      id: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      pairingId: input.pairingId ?? null,
      purpose: input.purpose,
      usedAt: null,
    };
    this.options.sqlite
      .prepare(
        `INSERT INTO auth_challenges
         (id, device_id, pairing_id, purpose, nonce, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        challenge.id,
        challenge.deviceId,
        challenge.pairingId,
        challenge.purpose,
        challenge.nonce,
        challenge.createdAt,
        challenge.expiresAt,
      );

    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      message: this.challengeMessage(challenge),
      nonce: challenge.nonce,
    };
  }

  private async verifyChallengeProof(input: {
    challengeId: string;
    device: DeviceRow;
    pairingId?: string;
    purpose: ChallengePurpose;
    signature: string;
  }): Promise<void> {
    const challenge = this.getChallenge(input.challengeId);
    this.assertChallengeMatches(challenge, input, this.now());
    if (
      !verifyDeviceProof(
        input.device.publicKey,
        this.challengeMessage(challenge),
        input.signature,
      )
    ) {
      throw new DeviceAuthError(
        "DEVICE_PROOF_INVALID",
        401,
        "The device signature did not verify for this challenge.",
      );
    }
  }

  private consumeChallenge(challengeId: string, usedAt: number): void {
    const changed = this.options.sqlite
      .prepare(
        "UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
      )
      .run(usedAt, challengeId, usedAt).changes;
    if (changed !== 1) {
      throw new DeviceAuthError(
        "CHALLENGE_ALREADY_USED",
        409,
        "The device challenge has already been consumed.",
      );
    }
  }

  private rotateRefreshCredential(
    credentialId: string,
    deviceId: string,
    now: number,
  ):
    | { credentials: IssuedDeviceCredentials; kind: "issued" }
    | { kind: "expired" | "reused" } {
    const credential = this.getDeviceCredential(credentialId);
    if (credential === undefined || credential.deviceId !== deviceId) {
      return { kind: "reused" };
    }
    if (credential.supersededAt !== null) {
      this.revokeDeviceWithinTransaction(deviceId, now);
      return { kind: "reused" };
    }
    if (
      now - credential.lastUsedAt >=
      REFRESH_INACTIVITY_LIFETIME_MILLISECONDS
    ) {
      return { kind: "expired" };
    }

    const superseded = this.options.sqlite
      .prepare(
        "UPDATE device_credentials SET superseded_at = ?, last_used_at = ? WHERE id = ? AND superseded_at IS NULL",
      )
      .run(now, now, credentialId);
    if (superseded.changes !== 1) {
      this.revokeDeviceWithinTransaction(deviceId, now);
      return { kind: "reused" };
    }

    return {
      credentials: this.issueCredentials(deviceId, now),
      kind: "issued",
    };
  }

  private issueCredentials(
    deviceId: string,
    now: number,
  ): IssuedDeviceCredentials {
    const refresh = createOpaqueToken("refresh");
    const access = createOpaqueToken("access");
    const accessExpiresAt = now + ACCESS_TOKEN_LIFETIME_MILLISECONDS;
    this.options.sqlite
      .prepare(
        `INSERT INTO device_credentials
         (id, device_id, secret_envelope, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        refresh.id,
        deviceId,
        this.encryptVerifier(
          "device_credentials",
          refresh.id,
          refresh.verifier,
        ),
        now,
        now,
      );
    this.options.sqlite
      .prepare(
        `INSERT INTO access_tokens
         (id, device_id, secret_envelope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        access.id,
        deviceId,
        this.encryptVerifier("access_tokens", access.id, access.verifier),
        now,
        accessExpiresAt,
      );

    return {
      accessExpiresAt,
      accessToken: access.token,
      refreshToken: refresh.token,
    };
  }

  private getAgentId(): string {
    const existing = this.options.settingsRepository.get(
      AGENT_IDENTITY_SETTINGS_KEY,
      agentIdentitySettingsSchema,
    );
    if (existing !== undefined) {
      return existing.agentId;
    }

    const agentId = randomUUID();
    this.options.settingsRepository.set(
      AGENT_IDENTITY_SETTINGS_KEY,
      { agentId },
      agentIdentitySettingsSchema,
    );
    return agentId;
  }

  private getPairing(pairingId: string): PairingRow {
    const pairing = this.options.sqlite
      .prepare<[string], PairingRow>(
        `SELECT approved_at AS approvedAt, created_at AS createdAt,
                credential_claimed_at AS credentialClaimedAt,
                device_display_name AS deviceDisplayName, device_id AS deviceId,
                device_public_key AS devicePublicKey, expires_at AS expiresAt,
                id, secret_envelope AS secretEnvelope, used_at AS usedAt
         FROM pairings WHERE id = ?`,
      )
      .get(pairingId);
    if (pairing === undefined) {
      throw new DeviceAuthError(
        "PAIRING_NOT_FOUND",
        404,
        "The pairing request was not found.",
      );
    }
    return pairing;
  }

  private getDevice(deviceId: string): DeviceRow {
    const device = this.options.sqlite
      .prepare<[string], DeviceRow>(
        "SELECT created_at AS createdAt, display_name AS displayName, id, public_key AS publicKey, revoked_at AS revokedAt FROM devices WHERE id = ?",
      )
      .get(deviceId);
    if (device === undefined) {
      throw new DeviceAuthError(
        "DEVICE_NOT_FOUND",
        404,
        "The paired device was not found.",
      );
    }
    return device;
  }

  private getChallenge(challengeId: string): ChallengeRow {
    const challenge = this.options.sqlite
      .prepare<[string], ChallengeRow>(
        `SELECT created_at AS createdAt, device_id AS deviceId,
                expires_at AS expiresAt, id, nonce, pairing_id AS pairingId,
                purpose, used_at AS usedAt
         FROM auth_challenges WHERE id = ?`,
      )
      .get(challengeId);
    if (challenge === undefined) {
      throw new DeviceAuthError(
        "CHALLENGE_NOT_FOUND",
        404,
        "The device challenge was not found.",
      );
    }
    return challenge;
  }

  private getRefreshCredential(
    credentialId: string,
  ): RefreshCredentialRow | undefined {
    return this.options.sqlite
      .prepare<[string], RefreshCredentialRow>(
        `SELECT credential.created_at AS createdAt,
                device.created_at AS deviceCreatedAt,
                device.display_name AS deviceDisplayName,
                credential.device_id AS deviceId,
                device.public_key AS devicePublicKey,
                device.revoked_at AS deviceRevokedAt,
                credential.id, credential.last_used_at AS lastUsedAt,
                credential.secret_envelope AS secretEnvelope,
                credential.superseded_at AS supersededAt
         FROM device_credentials AS credential
         JOIN devices AS device ON device.id = credential.device_id
         WHERE credential.id = ?`,
      )
      .get(credentialId);
  }

  private getDeviceCredential(
    credentialId: string,
  ):
    | Pick<
        RefreshCredentialRow,
        "deviceId" | "id" | "lastUsedAt" | "supersededAt"
      >
    | undefined {
    return this.options.sqlite
      .prepare<
        [string],
        Pick<
          RefreshCredentialRow,
          "deviceId" | "id" | "lastUsedAt" | "supersededAt"
        >
      >(
        "SELECT device_id AS deviceId, id, last_used_at AS lastUsedAt, superseded_at AS supersededAt FROM device_credentials WHERE id = ?",
      )
      .get(credentialId);
  }

  private getAccessToken(tokenId: string): AccessTokenRow | undefined {
    return this.options.sqlite
      .prepare<[string], AccessTokenRow>(
        `SELECT device.created_at AS deviceCreatedAt,
                device.display_name AS deviceDisplayName,
                token.device_id AS deviceId,
                device.public_key AS devicePublicKey,
                device.revoked_at AS deviceRevokedAt,
                token.expires_at AS expiresAt, token.id,
                token.revoked_at AS revokedAt,
                token.secret_envelope AS secretEnvelope
         FROM access_tokens AS token
         JOIN devices AS device ON device.id = token.device_id
         WHERE token.id = ?`,
      )
      .get(tokenId);
  }

  private assertPairingAvailableForRegistration(
    pairing: PairingRow,
    now: number,
  ): void {
    if (pairing.expiresAt <= now) {
      throw pairingExpiredError();
    }
    if (pairing.usedAt !== null || pairing.deviceId !== null) {
      throw pairingAlreadyUsedError();
    }
  }

  private assertPairingPendingApproval(pairing: PairingRow, now: number): void {
    if (pairing.expiresAt <= now) {
      throw pairingExpiredError();
    }
    if (
      pairing.usedAt === null ||
      pairing.approvedAt !== null ||
      pairing.deviceId !== null
    ) {
      throw new DeviceAuthError(
        "PAIRING_NOT_PENDING",
        409,
        "The pairing is not awaiting local approval.",
      );
    }
  }

  private assertPairingApproved(
    pairing: PairingRow,
    now: number,
  ): asserts pairing is PairingRow & { deviceId: string } {
    if (pairing.expiresAt <= now) {
      throw pairingExpiredError();
    }
    if (pairing.approvedAt === null || pairing.deviceId === null) {
      throw new DeviceAuthError(
        "PAIRING_NOT_APPROVED",
        409,
        "The pairing has not yet been approved locally.",
      );
    }
  }

  private assertDeviceActive(device: DeviceRow): void {
    if (device.revokedAt !== null) {
      throw new DeviceAuthError(
        "DEVICE_REVOKED",
        401,
        "The device session has been revoked.",
      );
    }
  }

  private assertChallengeMatches(
    challenge: ChallengeRow,
    input: {
      device: DeviceRow;
      pairingId?: string;
      purpose: ChallengePurpose;
    },
    now: number,
  ): void {
    if (challenge.expiresAt <= now) {
      throw new DeviceAuthError(
        "CHALLENGE_EXPIRED",
        410,
        "The device challenge has expired.",
      );
    }
    if (challenge.usedAt !== null) {
      throw new DeviceAuthError(
        "CHALLENGE_ALREADY_USED",
        409,
        "The device challenge has already been consumed.",
      );
    }
    if (
      challenge.deviceId !== input.device.id ||
      challenge.pairingId !== (input.pairingId ?? null) ||
      challenge.purpose !== input.purpose
    ) {
      throw new DeviceAuthError(
        "CHALLENGE_NOT_FOUND",
        404,
        "The device challenge does not match this operation.",
      );
    }
  }

  private challengeMessage(challenge: ChallengeRow): string {
    return JSON.stringify({
      agentId: this.getAgentId(),
      challengeId: challenge.id,
      deviceId: challenge.deviceId,
      expiresAt: challenge.expiresAt,
      nonce: challenge.nonce,
      pairingId: challenge.pairingId,
      purpose: challenge.purpose,
      version: 1,
    });
  }

  private encryptPairingSecret(
    pairingId: string,
    pairingSecret: z.infer<typeof pairingSecretSchema>,
  ): string {
    return JSON.stringify(
      encryptText(
        this.options.masterKey,
        createEncryptionContext({
          column: "secret_envelope",
          recordId: pairingId,
          table: "pairings",
        }),
        JSON.stringify(pairingSecret),
      ),
    );
  }

  private decryptPairingSecret(
    pairing: Pick<PairingRow, "id" | "secretEnvelope">,
  ): z.infer<typeof pairingSecretSchema> {
    const plaintext = decryptText(
      this.options.masterKey,
      createEncryptionContext({
        column: "secret_envelope",
        recordId: pairing.id,
        table: "pairings",
      }),
      parseEncryptedValueEnvelope(pairing.secretEnvelope),
    );
    return parseSecretJson(plaintext, pairingSecretSchema, "pairing secret");
  }

  private encryptVerifier(
    table: "access_tokens" | "device_credentials",
    recordId: string,
    verifier: string,
  ): string {
    return JSON.stringify(
      encryptText(
        this.options.masterKey,
        createEncryptionContext({
          column: "secret_envelope",
          recordId,
          table,
        }),
        verifier,
      ),
    );
  }

  private verifyStoredToken(
    secret: string,
    serializedEnvelope: string,
    context: {
      column: "secret_envelope";
      recordId: string;
      table: "access_tokens" | "device_credentials";
    },
  ): boolean {
    const verifier = decryptText(
      this.options.masterKey,
      createEncryptionContext(context),
      parseEncryptedValueEnvelope(serializedEnvelope),
    );
    return verifyTokenSecret(secret, verifier);
  }

  private revokeDeviceWithinTransaction(deviceId: string, now: number): void {
    this.options.sqlite
      .prepare(
        "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(now, deviceId);
    this.options.sqlite
      .prepare(
        "UPDATE access_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
      )
      .run(now, deviceId);
  }
}

function parseSecretJson<T>(
  plaintext: string,
  schema: z.ZodType<T>,
  name: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new StorageDataError(`The ${name} contains invalid JSON.`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StorageDataError(`The ${name} does not match its schema.`);
  }
  return result.data;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function pairingAlreadyUsedError(): DeviceAuthError {
  return new DeviceAuthError(
    "PAIRING_ALREADY_USED",
    409,
    "The pairing request has already been used.",
  );
}

function pairingExpiredError(): DeviceAuthError {
  return new DeviceAuthError(
    "PAIRING_EXPIRED",
    410,
    "The pairing request has expired.",
  );
}

function refreshTokenInvalidError(): DeviceAuthError {
  return new DeviceAuthError(
    "REFRESH_TOKEN_INVALID",
    401,
    "The refresh credential is invalid.",
  );
}

function accessTokenInvalidError(): DeviceAuthError {
  return new DeviceAuthError(
    "ACCESS_TOKEN_INVALID",
    401,
    "The access credential is invalid.",
  );
}
