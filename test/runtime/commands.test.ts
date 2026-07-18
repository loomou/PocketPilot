import { describe, expect, it } from "vitest";

import { isDevelopmentRuntimeModule } from "../../src/runtime/commands.js";

describe("runtime command mode", () => {
  it("distinguishes source development from built production entrypoints", () => {
    expect(
      isDevelopmentRuntimeModule(
        "file:///L:/code/test/js/remote-test/src/runtime/commands.ts",
      ),
    ).toBe(true);
    expect(
      isDevelopmentRuntimeModule(
        "file:///L:/code/test/js/remote-test/dist/cli.js",
      ),
    ).toBe(false);
  });
});
