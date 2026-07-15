import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DeviceAuthService } from "../../src/auth/device-auth-service.js";
import { buildLocalAdminApp } from "../../src/local-admin/app.js";
import { buildRemoteApiApp } from "../../src/remote-api/app.js";
import { writeRuntimeSettings } from "../../src/runtime/settings.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";

describe("pairing and device-authentication routes", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  const connections: StorageConnection[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps local approval local while issuing remote credentials after device proof", async () => {
    const service = createService(connections, temporaryDirectories);
    const localApp = await buildLocalAdminApp({
      csrfProtection: {
        expectedOrigin: () => "http://127.0.0.1:43183",
        token: "csrf-token",
      },
      deviceAuthService: service,
      getStatus: () => ({
        localAdminListener: { host: "127.0.0.1", port: 43183 },
        remoteListener: { host: "127.0.0.1", port: 43182 },
        status: "running" as const,
      }),
      requestShutdown: () => undefined,
      shutdownControlToken: "runtime-control-token",
    });
    const remoteApp = await buildRemoteApiApp({ deviceAuthService: service });
    apps.push(localApp, remoteApp);

    const csrfHeaders = {
      origin: "http://127.0.0.1:43183",
      "x-pocketpilot-csrf-token": "csrf-token",
    };
    const createdPairing = await localApp.inject({
      headers: csrfHeaders,
      method: "POST",
      url: "/admin/pairings",
    });
    expect(createdPairing.statusCode).toBe(201);
    const pairing = createdPairing.json<{
      pairingId: string;
      qrPayload: { baseUrl: string };
    }>();
    expect(pairing.qrPayload.baseUrl).toBe("https://agent.example.test");

    const keyPair = generateKeyPairSync("ed25519");
    const registration = await remoteApp.inject({
      method: "POST",
      payload: {
        deviceDisplayName: "Pixel",
        devicePublicKey: exportRawEd25519PublicKey(keyPair.publicKey),
      },
      url: `/v1/pair/${pairing.pairingId}/register`,
    });
    expect(registration.statusCode).toBe(200);
    const registrationBody = registration.json<{ verificationCode: string }>();

    const rejectedRemoteAdmin = await remoteApp.inject({
      method: "POST",
      url: `/admin/pairings/${pairing.pairingId}/approve`,
    });
    expect(rejectedRemoteAdmin.statusCode).toBe(404);

    const rejectedLocalApproval = await localApp.inject({
      method: "POST",
      payload: { verificationCode: registrationBody.verificationCode },
      url: `/admin/pairings/${pairing.pairingId}/approve`,
    });
    expect(rejectedLocalApproval.statusCode).toBe(403);

    const approved = await localApp.inject({
      headers: csrfHeaders,
      method: "POST",
      payload: { verificationCode: registrationBody.verificationCode },
      url: `/admin/pairings/${pairing.pairingId}/approve`,
    });
    expect(approved.statusCode).toBe(200);

    const challenge = await remoteApp.inject({
      method: "POST",
      url: `/v1/pair/${pairing.pairingId}/claim-challenge`,
    });
    expect(challenge.statusCode).toBe(200);
    const challengeBody = challenge.json<{
      challengeId: string;
      message: string;
    }>();
    const claimed = await remoteApp.inject({
      method: "POST",
      payload: {
        challengeId: challengeBody.challengeId,
        signature: sign(
          null,
          Buffer.from(challengeBody.message),
          keyPair.privateKey,
        ).toString("base64url"),
      },
      url: `/v1/pair/${pairing.pairingId}/claim`,
    });
    expect(claimed.statusCode).toBe(200);
    const credentials = claimed.json<{ accessToken: string }>();

    const session = await remoteApp.inject({
      headers: { authorization: `Bearer ${credentials.accessToken}` },
      method: "GET",
      url: "/v1/auth/session",
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ displayName: "Pixel" });
  });
});

function createService(
  connections: StorageConnection[],
  temporaryDirectories: string[],
): DeviceAuthService {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-auth-routes-"));
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
  return new DeviceAuthService({
    masterKey: Buffer.alloc(32, 11),
    settingsRepository,
    sqlite: connection.sqlite,
  });
}

function exportRawEd25519PublicKey(
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"],
): string {
  const encoded = publicKey.export({ format: "der", type: "spki" });
  return encoded.subarray(-32).toString("base64url");
}
