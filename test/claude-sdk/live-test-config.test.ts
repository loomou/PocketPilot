import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readLiveSdkTestConfig } from "./live-test-config.js";

describe("Claude SDK live test configuration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("stays disabled without the explicit live flag", () => {
    expect(
      readLiveSdkTestConfig({
        CLAUDE_SDK_TEST_CWD: "ignored-relative-path",
      }),
    ).toEqual({ enabled: false });
  });

  it("requires a configured workspace when live mode is enabled", () => {
    expect(() => readLiveSdkTestConfig({ CLAUDE_SDK_LIVE: "1" })).toThrow(
      "CLAUDE_SDK_TEST_CWD must be set when CLAUDE_SDK_LIVE=1.",
    );
  });

  it("rejects a relative workspace without exposing it in the error", () => {
    const configuredCwd = "private-relative-workspace";
    expect(() =>
      readLiveSdkTestConfig({
        CLAUDE_SDK_LIVE: "1",
        CLAUDE_SDK_TEST_CWD: configuredCwd,
      }),
    ).toThrow("CLAUDE_SDK_TEST_CWD must be an absolute directory.");

    try {
      readLiveSdkTestConfig({
        CLAUDE_SDK_LIVE: "1",
        CLAUDE_SDK_TEST_CWD: configuredCwd,
      });
    } catch (error) {
      expect(String(error)).not.toContain(configuredCwd);
    }
  });

  it("rejects missing paths and files with one safe error", () => {
    const directory = temporaryDirectory();
    const missingPath = join(directory, "private-missing-workspace");
    const filePath = join(directory, "private-workspace-file");
    writeFileSync(filePath, "not a directory", "utf8");

    for (const configuredCwd of [missingPath, filePath]) {
      try {
        readLiveSdkTestConfig({
          CLAUDE_SDK_LIVE: "1",
          CLAUDE_SDK_TEST_CWD: configuredCwd,
        });
        throw new Error("Expected live test configuration to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "CLAUDE_SDK_TEST_CWD must reference an existing directory.",
        );
        expect(String(error)).not.toContain(configuredCwd);
      }
    }
  });

  it("returns the canonical developer-supplied workspace", () => {
    const directory = temporaryDirectory();

    expect(
      readLiveSdkTestConfig({
        CLAUDE_SDK_LIVE: "1",
        CLAUDE_SDK_TEST_CWD: `  ${directory}  `,
      }),
    ).toEqual({ cwd: realpathSync(directory), enabled: true });
  });

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "pocketpilot-sdk-live-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});
