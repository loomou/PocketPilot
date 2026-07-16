import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireAgentLock } from "../../src/runtime/agent-lock.js";

describe("Agent data lock", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("allows only one runtime or maintenance owner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-agent-lock-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent.sqlite");

    const releaseFirst = await acquireAgentLock(databasePath);
    await expect(acquireAgentLock(databasePath)).rejects.toMatchObject({
      code: "AGENT_MAINTENANCE_LOCKED",
    });

    await releaseFirst();
    const releaseSecond = await acquireAgentLock(databasePath);
    await releaseSecond();
  });
});
