import { spawn } from "node:child_process";
import process from "node:process";

const workspace =
  process.env.CODEX_APP_SERVER_TEST_CWD?.trim() ||
  process.env.POCKETPILOT_CODEX_LIVE_CWD?.trim();

if (!workspace) {
  console.error(
    [
      "Codex live tests require a writable workspace path.",
      "Set CODEX_APP_SERVER_TEST_CWD to an authorized local directory,",
      "then re-run: npm run test:codex:live",
      "",
      "These tests stay opt-in so default CI remains hermetic.",
    ].join("\n"),
  );
  process.exit(1);
}

const env = {
  ...process.env,
  CODEX_APP_SERVER_TEST_CWD: workspace,
};

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "vitest",
    "run",
    "test/codex-app-server/live-contract.test.ts",
    "--reporter=verbose",
  ],
  {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
