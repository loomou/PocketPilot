import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadPocketPilotEnvironment,
  readAgentDataDirectory,
  readLocalAdminPort,
  readLogLevel,
} from "../../src/config/environment.js";
import { EnvironmentConfigurationError } from "../../src/config/errors.js";

describe("PocketPilot dotenv environment", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("loads only allowlisted keys from the exact startup directory", () => {
    const parent = createTemporaryDirectory(directories);
    const child = join(parent, "child");
    mkdirSync(child);
    writeFileSync(
      join(parent, ".env"),
      "AGENT_MASTER_KEY=parent\nPOCKETPILOT_DATA_DIR=parent-data\n",
    );
    writeFileSync(
      join(child, ".env"),
      [
        "AGENT_MASTER_KEY=child",
        "POCKETPILOT_DATA_DIR=child-data",
        "POCKETPILOT_LOCAL_ADMIN_PORT=44001",
        "POCKETPILOT_LOG_LEVEL=debug",
        "ANTHROPIC_API_KEY=must-not-load",
      ].join("\n"),
    );

    const environment = loadPocketPilotEnvironment({
      cwd: child,
      environment: { EXISTING: "preserved" },
    });

    expect(environment).toMatchObject({
      AGENT_MASTER_KEY: "child",
      EXISTING: "preserved",
      POCKETPILOT_DATA_DIR: "child-data",
      POCKETPILOT_LOCAL_ADMIN_PORT: "44001",
      POCKETPILOT_LOG_LEVEL: "debug",
    });
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("preserves explicit process values without mutating the input", () => {
    const cwd = createTemporaryDirectory(directories);
    writeFileSync(
      join(cwd, ".env"),
      "AGENT_MASTER_KEY=file-key\nPOCKETPILOT_DATA_DIR=file-data\n",
    );
    const input = {
      AGENT_MASTER_KEY: "",
      POCKETPILOT_DATA_DIR: "process-data",
    };

    const environment = loadPocketPilotEnvironment({
      cwd,
      environment: input,
    });

    expect(environment.AGENT_MASTER_KEY).toBe("");
    expect(environment.POCKETPILOT_DATA_DIR).toBe("process-data");
    expect(input).toEqual({
      AGENT_MASTER_KEY: "",
      POCKETPILOT_DATA_DIR: "process-data",
    });
  });

  it("allows a missing file and rejects an unreadable file safely", () => {
    const cwd = createTemporaryDirectory(directories);
    expect(
      loadPocketPilotEnvironment({ cwd, environment: { SAFE: "value" } }),
    ).toEqual({ SAFE: "value" });

    mkdirSync(join(cwd, ".env"));
    expect(() => loadPocketPilotEnvironment({ cwd, environment: {} })).toThrow(
      EnvironmentConfigurationError,
    );
  });

  it("validates the data directory and local administration port", () => {
    expect(readAgentDataDirectory({})).toBeUndefined();
    expect(readAgentDataDirectory({ POCKETPILOT_DATA_DIR: "D:\\Data" })).toBe(
      "D:\\Data",
    );
    expect(() =>
      readAgentDataDirectory({ POCKETPILOT_DATA_DIR: "   " }),
    ).toThrow("non-empty path");

    expect(readLocalAdminPort({})).toBeUndefined();
    expect(readLocalAdminPort({ POCKETPILOT_LOCAL_ADMIN_PORT: "43184" })).toBe(
      43_184,
    );
    for (const value of ["", "0", "65536", "1.5", "1e3", "port"]) {
      expect(() =>
        readLocalAdminPort({ POCKETPILOT_LOCAL_ADMIN_PORT: value }),
      ).toThrow("integer from 1 through 65535");
    }
  });

  it("validates foreground log verbosity", () => {
    expect(readLogLevel({})).toBe("info");
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(readLogLevel({ POCKETPILOT_LOG_LEVEL: level })).toBe(level);
    }
    for (const value of ["", "trace", "INFO", "verbose"]) {
      expect(() => readLogLevel({ POCKETPILOT_LOG_LEVEL: value })).toThrow(
        "POCKETPILOT_LOG_LEVEL must be one of: debug, info, warn, error.",
      );
    }
  });

  it("never includes dotenv secrets or rejected values in validation errors", () => {
    const cwd = createTemporaryDirectory(directories);
    writeFileSync(
      join(cwd, ".env"),
      [
        "AGENT_MASTER_KEY=do-not-expose-this-key",
        "POCKETPILOT_LOCAL_ADMIN_PORT=do-not-expose-this-value",
      ].join("\n"),
    );
    const environment = loadPocketPilotEnvironment({ cwd, environment: {} });

    expect(() => readLocalAdminPort(environment)).toThrow(
      "POCKETPILOT_LOCAL_ADMIN_PORT must be an integer from 1 through 65535.",
    );
    try {
      readLocalAdminPort(environment);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("do-not-expose-this-key");
      expect(message).not.toContain("do-not-expose-this-value");
    }
  });
});

function createTemporaryDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-environment-"));
  directories.push(directory);
  return directory;
}
