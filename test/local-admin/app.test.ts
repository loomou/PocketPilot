import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildLocalAdminApp } from "../../src/local-admin/app.js";
import { buildRemoteApiApp } from "../../src/remote-api/app.js";

describe("local administration application", () => {
  const apps: Array<Awaited<ReturnType<typeof buildLocalAdminApp>>> = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps local status separate and protects unsafe local-admin requests", async () => {
    let shutdownRequests = 0;
    const app = await buildLocalAdminApp({
      csrfProtection: {
        expectedOrigin: () => "http://127.0.0.1:43183",
        token: "csrf-token",
      },
      getStatus: () => ({
        localAdminListener: { host: "127.0.0.1", port: 43183 },
        remoteListener: { host: "127.0.0.1", port: 43182 },
        status: "running" as const,
      }),
      requestShutdown: () => {
        shutdownRequests += 1;
      },
      shutdownControlToken: "runtime-control-token",
    });
    apps.push(app);

    const status = await app.inject({ method: "GET", url: "/admin/status" });
    const rejectedMutation = await app.inject({
      method: "POST",
      url: "/admin/not-configured",
    });
    const sameOriginMutation = await app.inject({
      headers: {
        origin: "http://127.0.0.1:43183",
        "x-pocketpilot-csrf-token": "csrf-token",
      },
      method: "POST",
      url: "/admin/not-configured",
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: "running" });
    expect(rejectedMutation.statusCode).toBe(403);
    expect(rejectedMutation.json()).toMatchObject({
      code: "LOCAL_ADMIN_CSRF_REJECTED",
    });
    expect(sameOriginMutation.statusCode).toBe(404);

    const rejectedShutdown = await app.inject({
      method: "POST",
      url: "/_internal/shutdown",
    });
    const acceptedShutdown = await app.inject({
      headers: {
        "x-pocketpilot-control-token": "runtime-control-token",
      },
      method: "POST",
      url: "/_internal/shutdown",
    });

    expect(rejectedShutdown.statusCode).toBe(401);
    expect(acceptedShutdown.statusCode).toBe(202);
    expect(shutdownRequests).toBe(1);
  });

  it("serves built administration assets locally but never remotely", async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), "pocketpilot-admin-static-"));
    directories.push(staticRoot);
    writeFileSync(
      join(staticRoot, "index.html"),
      "<!doctype html><title>PocketPilot static shell</title>",
    );
    const localApp = await buildLocalAdminApp({
      csrfProtection: {
        expectedOrigin: () => "http://127.0.0.1:43183",
        token: "csrf-token",
      },
      getStatus: () => ({
        localAdminListener: { host: "127.0.0.1", port: 43183 },
        remoteListener: { host: "127.0.0.1", port: 43182 },
        status: "running" as const,
      }),
      requestShutdown: () => undefined,
      shutdownControlToken: "runtime-control-token",
      staticRoot,
    });
    const remoteApp = await buildRemoteApiApp();
    apps.push(localApp, remoteApp);

    const localPage = await localApp.inject({ method: "GET", url: "/" });
    const remotePage = await remoteApp.inject({ method: "GET", url: "/" });

    expect(localPage.statusCode).toBe(200);
    expect(localPage.headers["content-type"]).toContain("text/html");
    expect(localPage.body).toContain("PocketPilot static shell");
    expect(remotePage.statusCode).toBe(404);
    expect(remotePage.body).not.toContain("PocketPilot static shell");
  });
});
