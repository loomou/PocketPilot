import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("buildApp", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("provides a health endpoint without binding a listener", async () => {
    const app = await buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
