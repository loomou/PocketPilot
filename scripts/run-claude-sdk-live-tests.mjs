import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const vitestPackage = fileURLToPath(import.meta.resolve("vitest/package.json"));
const vitestCli = join(dirname(vitestPackage), "vitest.mjs");
const child = spawn(
  process.execPath,
  [vitestCli, "run", "test/claude-sdk/live-contract.test.ts"],
  {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_SDK_LIVE: "1" },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", () => {
  console.error("Unable to start the Claude SDK live test process.");
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
