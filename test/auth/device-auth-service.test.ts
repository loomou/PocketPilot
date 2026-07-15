import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeviceAuthService,
  type DeviceConnectionRegistry,
} from "../../src/auth/device-auth-service.js";
import { DeviceAuthError } from "../../src/auth/errors.js";
import { writeRuntimeSettings } from "../../src/runtime/settings.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";

describe("DeviceAuthService", () => {
  const connections: StorageConnection[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("pairs an approved device, rotates refresh credentials, and revokes reuse", async () => {
    const now = 1_000_000;
    const closedDeviceIds: string[] = [];
    const service = createService(
      connections,
      temporaryDirectories,
      () => now,
      {
        closeDeviceConnections(deviceId): void {
          closedDeviceIds.push(deviceId);
        },
      },
    );
    const keyPair = generateKeyPairSync("ed25519");
    const publicKey = exportRawEd25519PublicKey(keyPair.publicKey);

    const pairing = service.createPairing();
    expect(pairing.qrPayload).toMatchObject({
      baseUrl: "https://agent.example.test",
      pairingId: pairing.pairingId,
      version: 1,
    });
    expect(JSON.stringify(pairing.qrPayload)).not.toContain("access");
    expect(JSON.stringify(pairing.qrPayload)).not.toContain("refresh");

    const registration = service.registerPairingDevice({
      deviceDisplayName: "Pixel",
      devicePublicKey: publicKey,
      pairingId: pairing.pairingId,
    });
    expect(service.listPendingPairings()).toEqual([
      {
        deviceDisplayName: "Pixel",
        expiresAt: pairing.expiresAt,
        pairingId: pairing.pairingId,
        verificationCode: registration.verificationCode,
      },
    ]);

    const device = service.approvePairing({
      pairingId: pairing.pairingId,
      verificationCode: registration.verificationCode,
    });
    const pairingChallenge = service.createPairingClaimChallenge(
      pairing.pairingId,
    );
    const initialCredentials = await service.claimPairingCredentials({
      challengeId: pairingChallenge.challengeId,
      pairingId: pairing.pairingId,
      signature: signChallenge(pairingChallenge.message, keyPair.privateKey),
    });

    expect(
      service.authenticateAccessToken(initialCredentials.accessToken),
    ).toEqual(device);
    const refreshChallenge = service.createRefreshChallenge(device.id);
    const refreshedCredentials = await service.refreshCredentials({
      challengeId: refreshChallenge.challengeId,
      refreshToken: initialCredentials.refreshToken,
      signature: signChallenge(refreshChallenge.message, keyPair.privateKey),
    });
    expect(refreshedCredentials.refreshToken).not.toBe(
      initialCredentials.refreshToken,
    );

    const reuseChallenge = service.createRefreshChallenge(device.id);
    await expect(
      service.refreshCredentials({
        challengeId: reuseChallenge.challengeId,
        refreshToken: initialCredentials.refreshToken,
        signature: signChallenge(reuseChallenge.message, keyPair.privateKey),
      }),
    ).rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSED" });
    expect(closedDeviceIds).toEqual([device.id]);
    expect(() =>
      service.authenticateAccessToken(refreshedCredentials.accessToken),
    ).toThrow(DeviceAuthError);
    expect(() =>
      service.authenticateAccessToken(refreshedCredentials.accessToken),
    ).toThrow(expect.objectContaining({ code: "ACCESS_TOKEN_REVOKED" }));
  });

  it("rejects expired pairings, stale challenges, and refresh inactivity", async () => {
    let now = 2_000_000;
    const service = createService(connections, temporaryDirectories, () => now);
    const keyPair = generateKeyPairSync("ed25519");
    const publicKey = exportRawEd25519PublicKey(keyPair.publicKey);

    const expiredPairing = service.createPairing();
    now = expiredPairing.expiresAt + 1;
    expect(() =>
      service.registerPairingDevice({
        deviceDisplayName: "Pixel",
        devicePublicKey: publicKey,
        pairingId: expiredPairing.pairingId,
      }),
    ).toThrow(expect.objectContaining({ code: "PAIRING_EXPIRED" }));

    now = 3_000_000;
    const paired = await pairAndClaimDevice(service);
    const challenge = service.createRefreshChallenge(paired.device.id);
    now = challenge.expiresAt + 1;
    await expect(
      service.refreshCredentials({
        challengeId: challenge.challengeId,
        refreshToken: paired.credentials.refreshToken,
        signature: signChallenge(challenge.message, paired.keyPair.privateKey),
      }),
    ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });

    now += 30 * 24 * 60 * 60 * 1000;
    const inactiveChallenge = service.createRefreshChallenge(paired.device.id);
    await expect(
      service.refreshCredentials({
        challengeId: inactiveChallenge.challengeId,
        refreshToken: paired.credentials.refreshToken,
        signature: signChallenge(
          inactiveChallenge.message,
          paired.keyPair.privateKey,
        ),
      }),
    ).rejects.toMatchObject({ code: "REFRESH_TOKEN_EXPIRED" });
  });

  it("keeps independently paired devices active when one device is revoked", async () => {
    let now = 4_000_000;
    const service = createService(connections, temporaryDirectories, () => now);
    const first = await pairAndClaimDevice(service);
    now += 1;
    const second = await pairAndClaimDevice(service);

    expect(service.listDevices().map((device) => device.id)).toEqual([
      first.device.id,
      second.device.id,
    ]);
    expect(service.revokeDevice(first.device.id)).toBe(true);
    expect(() =>
      service.authenticateAccessToken(first.credentials.accessToken),
    ).toThrow(expect.objectContaining({ code: "ACCESS_TOKEN_REVOKED" }));
    expect(
      service.authenticateAccessToken(second.credentials.accessToken),
    ).toEqual(second.device);
  });

  it("stores only encrypted credential verifiers, never issued token plaintext", async () => {
    const context = createServiceContext(
      connections,
      temporaryDirectories,
      Date.now,
    );
    const paired = await pairAndClaimDevice(context.service);
    const serializedRows = JSON.stringify(
      context.connection.sqlite
        .prepare(
          "SELECT secret_envelope FROM device_credentials UNION ALL SELECT secret_envelope FROM access_tokens",
        )
        .all(),
    );

    expect(serializedRows).not.toContain(paired.credentials.accessToken);
    expect(serializedRows).not.toContain(paired.credentials.refreshToken);
  });

  it("lets the approved device recover a lost claim response without a second pairing", async () => {
    const service = createService(connections, temporaryDirectories, Date.now);
    const paired = await pairAndClaimDevice(service);
    const recoveryChallenge = service.createPairingClaimChallenge(
      paired.pairingId,
    );
    const recoveredCredentials = await service.claimPairingCredentials({
      challengeId: recoveryChallenge.challengeId,
      pairingId: paired.pairingId,
      signature: signChallenge(
        recoveryChallenge.message,
        paired.keyPair.privateKey,
      ),
    });

    expect(() =>
      service.authenticateAccessToken(paired.credentials.accessToken),
    ).toThrow(expect.objectContaining({ code: "ACCESS_TOKEN_REVOKED" }));
    expect(
      service.authenticateAccessToken(recoveredCredentials.accessToken),
    ).toEqual(paired.device);
  });
});

function createService(
  connections: StorageConnection[],
  temporaryDirectories: string[],
  now: () => number,
  closeDeviceConnections?: DeviceConnectionRegistry,
): DeviceAuthService {
  return createServiceContext(
    connections,
    temporaryDirectories,
    now,
    closeDeviceConnections,
  ).service;
}

function createServiceContext(
  connections: StorageConnection[],
  temporaryDirectories: string[],
  now: () => number,
  closeDeviceConnections?: DeviceConnectionRegistry,
): { connection: StorageConnection; service: DeviceAuthService } {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-auth-"));
  const connection = openStorage({
    databasePath: join(directory, "agent.sqlite"),
  });
  const settingsRepository = new SettingsRepository(connection.database);
  writeRuntimeSettings(settingsRepository, {
    mobileBaseUrl: "https://agent.example.test",
    remoteListener: { host: "127.0.0.1", port: 43182 },
  });
  connections.push(connection);
  temporaryDirectories.push(directory);

  const service = new DeviceAuthService({
    ...(closeDeviceConnections === undefined ? {} : { closeDeviceConnections }),
    masterKey: Buffer.alloc(32, 7),
    now,
    settingsRepository,
    sqlite: connection.sqlite,
  });
  return { connection, service };
}

async function pairAndClaimDevice(service: DeviceAuthService): Promise<{
  device: ReturnType<DeviceAuthService["approvePairing"]>;
  credentials: Awaited<
    ReturnType<DeviceAuthService["claimPairingCredentials"]>
  >;
  keyPair: ReturnType<typeof generateKeyPairSync>;
  pairingId: string;
}> {
  const keyPair = generateKeyPairSync("ed25519");
  const pairing = service.createPairing();
  const registration = service.registerPairingDevice({
    deviceDisplayName: "Pixel",
    devicePublicKey: exportRawEd25519PublicKey(keyPair.publicKey),
    pairingId: pairing.pairingId,
  });
  const device = service.approvePairing({
    pairingId: pairing.pairingId,
    verificationCode: registration.verificationCode,
  });
  const challenge = service.createPairingClaimChallenge(pairing.pairingId);
  const credentials = await service.claimPairingCredentials({
    challengeId: challenge.challengeId,
    pairingId: pairing.pairingId,
    signature: signChallenge(challenge.message, keyPair.privateKey),
  });
  return { credentials, device, keyPair, pairingId: pairing.pairingId };
}

function exportRawEd25519PublicKey(
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"],
): string {
  const encoded = publicKey.export({ format: "der", type: "spki" });
  return encoded.subarray(-32).toString("base64url");
}

function signChallenge(
  message: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): string {
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString(
    "base64url",
  );
}
