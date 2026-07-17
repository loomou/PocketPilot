import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { requestRuntimeShutdown } from "../../src/runtime/commands.js";
import { writeRuntimeSettings } from "../../src/runtime/settings.js";
import { openStorage } from "../../src/storage/database.js";
import { SettingsRepository } from "../../src/storage/settings-repository.js";

const masterKey = Buffer.alloc(32, 1).toString("base64url");

describe("AgentRuntime", () => {
  const runtimes: AgentRuntime[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails before opening storage or binding listeners without a master key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-runtime-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent.sqlite");
    const runtimeControlPath = join(directory, "runtime-control.json");
    const runtime = new AgentRuntime({
      databasePath,
      environment: {},
      installSignalHandlers: false,
      runtimeControlPath,
    });
    runtimes.push(runtime);

    await expect(runtime.start()).rejects.toMatchObject({
      code: "MASTER_KEY_MISSING",
    });
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(runtimeControlPath)).toBe(false);
  });

  it("keeps local administration off the remote listener and shares shutdown with agent stop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-runtime-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent.sqlite");
    const runtimeControlPath = join(directory, "runtime-control.json");
    await configureEphemeralRemoteListener(databasePath);

    const runtime = new AgentRuntime({
      databasePath,
      environment: { AGENT_MASTER_KEY: masterKey },
      installSignalHandlers: false,
      localAdminPort: 0,
      runtimeControlPath,
    });
    runtimes.push(runtime);

    const status = await runtime.start();
    const remoteHealth = await fetch(
      `http://${status.remoteListener.host}:${status.remoteListener.port}/healthz`,
    );
    const remoteLocalAdmin = await fetch(
      `http://${status.remoteListener.host}:${status.remoteListener.port}/admin/status`,
    );
    const localStatus = await fetch(
      `http://${status.localAdminListener.host}:${status.localAdminListener.port}/admin/status`,
    );

    expect(remoteHealth.status).toBe(200);
    expect(remoteLocalAdmin.status).toBe(404);
    expect(localStatus.status).toBe(200);
    expect(existsSync(runtimeControlPath)).toBe(true);

    await requestRuntimeShutdown(runtimeControlPath);
    await runtime.waitUntilStopped();

    expect(existsSync(runtimeControlPath)).toBe(false);
  });

  it("terminates persisted idle sessions during a manual Agent shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-runtime-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent.sqlite");
    const runtimeControlPath = join(directory, "runtime-control.json");
    await configureEphemeralRemoteListener(databasePath);
    const initialStorage = openStorage({ databasePath });
    initialStorage.sqlite
      .prepare(
        "INSERT INTO tasks (id, initial_cwd, permission_mode, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "00000000-0000-4000-8000-000000000001",
        directory,
        "default",
        "idle",
        1,
        1,
      );
    initialStorage.close();

    const runtime = new AgentRuntime({
      databasePath,
      environment: { AGENT_MASTER_KEY: masterKey },
      installSignalHandlers: false,
      localAdminPort: 0,
      runtimeControlPath,
    });
    runtimes.push(runtime);

    await runtime.start();
    await runtime.shutdown();

    const verifiedStorage = openStorage({ databasePath });
    try {
      expect(
        verifiedStorage.sqlite
          .prepare("SELECT state, terminal_at AS terminalAt FROM tasks")
          .get(),
      ).toMatchObject({ state: "terminal" });
    } finally {
      verifiedStorage.close();
    }
  }, 10_000);

  it("rejects a second runtime and a wrong persisted master key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-runtime-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent.sqlite");
    await configureEphemeralRemoteListener(databasePath);
    const firstRuntime = new AgentRuntime({
      databasePath,
      environment: { AGENT_MASTER_KEY: masterKey },
      installSignalHandlers: false,
      localAdminPort: 0,
      runtimeControlPath: join(directory, "runtime-control.json"),
    });
    const secondRuntime = new AgentRuntime({
      databasePath,
      environment: { AGENT_MASTER_KEY: masterKey },
      installSignalHandlers: false,
      localAdminPort: 0,
      runtimeControlPath: join(directory, "second-runtime-control.json"),
    });
    runtimes.push(firstRuntime, secondRuntime);

    await firstRuntime.start();
    await expect(secondRuntime.start()).rejects.toMatchObject({
      code: "AGENT_MAINTENANCE_LOCKED",
    });
    await firstRuntime.shutdown();

    const wrongKeyRuntime = new AgentRuntime({
      databasePath,
      environment: {
        AGENT_MASTER_KEY: Buffer.alloc(32, 2).toString("base64url"),
      },
      installSignalHandlers: false,
      localAdminPort: 0,
      runtimeControlPath: join(directory, "wrong-key-runtime-control.json"),
    });
    runtimes.push(wrongKeyRuntime);
    await expect(wrongKeyRuntime.start()).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });
});

async function configureEphemeralRemoteListener(
  databasePath: string,
): Promise<void> {
  const storage = openStorage({ databasePath });
  try {
    writeRuntimeSettings(new SettingsRepository(storage.database), {
      remoteListener: { host: "127.0.0.1", port: await findAvailablePort() },
    });
  } finally {
    storage.close();
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test server did not receive a TCP port.");
  }
  const { port } = address;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}
