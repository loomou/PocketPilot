import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type LiveSdkTestConfig =
  | { enabled: false }
  | { cwd: string; enabled: true };

type TestEnvironment = Readonly<Record<string, string | undefined>>;

export function readLiveSdkTestConfig(
  environment: TestEnvironment = process.env,
): LiveSdkTestConfig {
  if (environment.CLAUDE_SDK_LIVE !== "1") {
    return { enabled: false };
  }

  const configuredCwd = environment.CLAUDE_SDK_TEST_CWD?.trim();
  if (configuredCwd === undefined || configuredCwd.length === 0) {
    throw new Error("CLAUDE_SDK_TEST_CWD must be set when CLAUDE_SDK_LIVE=1.");
  }
  if (!isAbsolute(configuredCwd)) {
    throw new Error("CLAUDE_SDK_TEST_CWD must be an absolute directory.");
  }

  let cwd: string;
  try {
    cwd = realpathSync(configuredCwd);
    if (!statSync(cwd).isDirectory()) {
      throw new Error("not-a-directory");
    }
  } catch {
    throw new Error(
      "CLAUDE_SDK_TEST_CWD must reference an existing directory.",
    );
  }

  return { cwd, enabled: true };
}
