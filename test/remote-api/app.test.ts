import { afterEach, describe, expect, it } from "vitest";

import { buildRemoteApiApp } from "../../src/remote-api/app.js";

describe("remote API application", () => {
  const apps: Array<Awaited<ReturnType<typeof buildRemoteApiApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("does not mount localhost-only administration routes", async () => {
    const app = await buildRemoteApiApp();
    apps.push(app);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const localAdmin = await app.inject({
      method: "GET",
      url: "/admin/status",
    });
    const documentation = await app.inject({
      method: "GET",
      url: "/documentation/json",
    });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(localAdmin.statusCode).toBe(404);
    expect(documentation.statusCode).toBe(404);
  });
});
