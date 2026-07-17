import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DeviceAuthService } from "../../src/auth/device-auth-service.js";
import { buildRemoteApiApp } from "../../src/remote-api/app.js";
import { writeRuntimeSettings } from "../../src/runtime/settings.js";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";
import { writeTaskRuntimeSettings } from "../../src/tasks/settings.js";
import { TaskManager } from "../../src/tasks/task-manager.js";

describe("versioned task routes", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  const connections: StorageConnection[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const connection of connections.splice(0)) connection.close();
    for (const directory of directories.splice(0))
      rmSync(directory, { force: true, recursive: true });
  });

  it("requires a device token and creates an acknowledged authorized task", async () => {
    const fixture = await createFixture(connections, directories);
    const app = await buildRemoteApiApp({
      deviceAuthService: fixture.auth,
      taskManager: fixture.manager,
    });
    apps.push(app);
    const unauthorized = await app.inject({ method: "GET", url: "/v1/tasks" });
    expect(unauthorized.statusCode).toBe(401);
    const unauthorizedWorkspaces = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
    });
    expect(unauthorizedWorkspaces.statusCode).toBe(401);
    const capabilities = await app.inject({
      headers: fixture.headers,
      method: "GET",
      url: "/v1/capabilities",
    });
    expect(capabilities.statusCode).toBe(200);
    const workspaces = await app.inject({
      headers: fixture.headers,
      method: "GET",
      url: "/v1/workspaces",
    });
    expect(workspaces.statusCode).toBe(200);
    expect(workspaces.json()).toEqual({
      workspaceRoots: [fixture.workspace],
    });
    const rejected = await app.inject({
      headers: fixture.headers,
      method: "POST",
      url: "/v1/tasks",
      payload: {
        initialCwd: fixture.workspace,
        operationId: randomUUID(),
        permissionMode: "default",
        workspaceRiskAccepted: false,
      },
    });
    expect(rejected.json()).toMatchObject({
      code: "WORKSPACE_SCOPE_RISK_NOT_ACCEPTED",
    });
    const created = await app.inject({
      headers: fixture.headers,
      method: "POST",
      url: "/v1/tasks",
      payload: {
        initialCwd: fixture.workspace,
        operationId: randomUUID(),
        permissionMode: "default",
        workspaceRiskAccepted: true,
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      action: "created",
      task: { state: "idle" },
    });
  });
});

async function createFixture(
  connections: StorageConnection[],
  directories: string[],
): Promise<{
  auth: DeviceAuthService;
  headers: { authorization: string };
  manager: TaskManager;
  workspace: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-task-routes-"));
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const connection = openStorage({
    databasePath: join(directory, "agent.sqlite"),
  });
  const settings = new SettingsRepository(connection.database);
  writeRuntimeSettings(settings, {
    mobileBaseUrl: "https://agent.example.test",
    remoteListener: { host: "127.0.0.1", port: 43182 },
  });
  writeTaskRuntimeSettings(settings, {
    concurrentTaskCapacity: 3,
    workspaceRoots: [workspace],
  });
  const auth = new DeviceAuthService({
    masterKey: Buffer.alloc(32, 5),
    settingsRepository: settings,
    sqlite: connection.sqlite,
  });
  const pairing = auth.createPairing();
  const pair = generateKeyPairSync("ed25519");
  const registration = auth.registerPairingDevice({
    deviceDisplayName: "Phone",
    devicePublicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url"),
    pairingId: pairing.pairingId,
  });
  auth.approvePairing({
    pairingId: pairing.pairingId,
    verificationCode: registration.verificationCode,
  });
  const challenge = auth.createPairingClaimChallenge(pairing.pairingId);
  const credentials = await auth.claimPairingCredentials({
    challengeId: challenge.challengeId,
    pairingId: pairing.pairingId,
    signature: sign(
      null,
      Buffer.from(challenge.message),
      pair.privateKey,
    ).toString("base64url"),
  });
  connections.push(connection);
  directories.push(directory);
  return {
    auth,
    headers: { authorization: `Bearer ${credentials.accessToken}` },
    manager: new TaskManager({
      settingsRepository: settings,
      sqlite: connection.database,
    }),
    workspace,
  };
}
