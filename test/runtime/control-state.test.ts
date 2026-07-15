import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  removeRuntimeControlState,
  writeRuntimeControlState,
} from "../../src/runtime/control-state.js";

describe("runtime control state", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("only removes the state file owned by the stopping runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-control-state-"));
    temporaryDirectories.push(directory);
    const controlStatePath = join(directory, "runtime-control.json");

    await writeRuntimeControlState(controlStatePath, {
      localAdminPort: 43183,
      shutdownControlToken: "runtime-control-token-which-is-long-enough",
      version: 1,
    });

    await removeRuntimeControlState(
      controlStatePath,
      "different-runtime-token-which-is-long-enough",
    );
    expect(existsSync(controlStatePath)).toBe(true);

    await removeRuntimeControlState(
      controlStatePath,
      "runtime-control-token-which-is-long-enough",
    );
    expect(existsSync(controlStatePath)).toBe(false);
  });
});
