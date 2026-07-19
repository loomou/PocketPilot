import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = process.env.CODEX_APP_SERVER_TEST_CWD;
if (
  workspace === undefined ||
  !isAbsolute(workspace) ||
  !existsSync(workspace) ||
  !statSync(workspace).isDirectory()
) {
  console.error(
    "CODEX_APP_SERVER_TEST_CWD must be an existing absolute workspace directory.",
  );
  process.exitCode = 2;
} else {
  const vitestPackage = fileURLToPath(import.meta.resolve("vitest/package.json"));
  const vitestCli = join(vitestPackage, "..", "vitest.mjs");
  const child = spawn(
    process.execPath,
    [vitestCli, "run", "test/codex-app-server/live-contract.test.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_APP_SERVER_TEST_CWD: workspace },
      stdio: "inherit",
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("error", () => {
    console.error("Unable to start the Codex App Server live test process.");
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}
