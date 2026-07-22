import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerBridge,
  isCodexCommandAvailable,
  probeCodexReadiness,
} from "../../src/codex-app-server/bridge.js";
import { CodexProviderAdapter } from "../../src/codex-app-server/provider-adapter.js";
import type {
  CodexBridgeDelivery,
  CodexJsonObject,
} from "../../src/codex-app-server/types.js";
import { readCodexCommand } from "../../src/config/environment.js";

const workspace = process.env.CODEX_APP_SERVER_TEST_CWD;
const describeLive = workspace === undefined ? describe.skip : describe;

describeLive("Codex App Server live contract", () => {
  it("initializes, exposes native catalogs, streams a turn, reads/resumes history, and shuts down cleanly", async () => {
    const liveWorkspace = requireString(workspace, "CODEX_APP_SERVER_TEST_CWD");
    const bridge = new CodexAppServerBridge({
      ...(process.env.POCKETPILOT_CODEX_COMMAND === undefined
        ? {}
        : { command: process.env.POCKETPILOT_CODEX_COMMAND }),
      cwd: liveWorkspace,
      requestTimeoutMs: 120_000,
    });
    const notifications: CodexBridgeDelivery[] = [];
    bridge.subscribe((delivery) => notifications.push(delivery));

    let threadId: string | undefined;
    try {
      await expect(bridge.start()).resolves.toMatchObject({
        cliVersion: expect.stringMatching(/^0\.144\./u),
      });

      const models = asObject(await bridge.request("model/list", {}));
      expect(Array.isArray(models.data)).toBe(true);
      const collaborationModes = asObject(
        await bridge.request("collaborationMode/list", {}),
      );
      expect(Array.isArray(collaborationModes.data)).toBe(true);
      const permissionProfiles = asObject(
        await bridge.request("permissionProfile/list", {}),
      );
      expect(Array.isArray(permissionProfiles.data)).toBe(true);

      const listed = asObject(
        await bridge.request("thread/list", {
          cwd: liveWorkspace,
          limit: 100,
          sourceKinds: ["cli", "vscode", "appServer"],
        }),
      );
      expect(Array.isArray(listed.data)).toBe(true);

      const started = asObject(
        await bridge.request("thread/start", {
          approvalPolicy: "never",
          cwd: liveWorkspace,
          ephemeral: false,
          sandbox: "read-only",
          threadSource: "pocketpilot-live-test",
        }),
      );
      const thread = asObject(started.thread);
      threadId = requireString(thread.id, "thread.id");
      expect(
        samePath(requireString(thread.cwd, "thread.cwd"), liveWorkspace),
      ).toBe(true);

      const turnStart = asObject(
        await bridge.request("turn/start", {
          approvalPolicy: "never",
          input: [
            {
              text: "Reply with exactly the word OK and do not use tools.",
              text_elements: [],
              type: "text",
            },
          ],
          sandboxPolicy: { type: "readOnly" },
          threadId,
        }),
      );
      const turn = asObject(turnStart.turn);
      expect(typeof turn.id).toBe("string");

      await waitForNotification(notifications, (delivery) => {
        return (
          delivery.frame.method === "turn/completed" &&
          isObject(delivery.frame.params) &&
          delivery.frame.params.threadId === threadId
        );
      });
      expect(
        notifications.some(
          (delivery) => delivery.frame.method === "item/agentMessage/delta",
        ),
      ).toBe(true);

      const history = asObject(
        await bridge.request("thread/read", {
          includeTurns: true,
          threadId,
        }),
      );
      expect(isObject(history.thread)).toBe(true);

      const turns = asObject(
        await bridge.request("thread/turns/list", {
          itemsView: "full",
          limit: 50,
          sortDirection: "desc",
          threadId,
        }),
      );
      expect(Array.isArray(turns.data)).toBe(true);

      const resumed = asObject(
        await bridge.request("thread/resume", {
          excludeTurns: true,
          threadId,
        }),
      );
      expect(requireString(asObject(resumed.thread).id, "thread.id")).toBe(
        threadId,
      );

      const interruptEventOffset = notifications.length;
      await bridge.forward("live-interrupt-task", {
        id: "live-interrupt-start",
        method: "turn/start",
        params: {
          approvalPolicy: "never",
          input: [
            {
              text: [
                "Use the shell to run this exact PowerShell command:",
                "Start-Sleep -Seconds 30",
                "Wait for it to finish before replying.",
              ].join("\n"),
              text_elements: [],
              type: "text",
            },
          ],
          sandboxPolicy: { type: "readOnly" },
          threadId,
        },
      });
      const interruptStarted = await waitForNotification(
        notifications,
        (delivery) => {
          return (
            delivery.frame.method === "turn/started" &&
            isObject(delivery.frame.params) &&
            delivery.frame.params.threadId === threadId
          );
        },
        interruptEventOffset,
      );
      const interruptTurnId = requireString(
        asObject(asObject(interruptStarted.frame.params).turn).id,
        "turn.id",
      );
      await expect(
        bridge.request("turn/steer", {
          expectedTurnId: interruptTurnId,
          input: [
            {
              text: "After the command finishes, reply with exactly DONE.",
              text_elements: [],
              type: "text",
            },
          ],
          threadId,
        }),
      ).resolves.toBeDefined();
      await expect(
        bridge.request("turn/interrupt", { threadId, turnId: interruptTurnId }),
      ).resolves.toBeDefined();
      await waitForNotification(notifications, (delivery) => {
        return (
          delivery.frame.method === "turn/completed" &&
          isObject(delivery.frame.params) &&
          delivery.frame.params.threadId === threadId &&
          isObject(delivery.frame.params.turn) &&
          delivery.frame.params.turn.id === interruptTurnId
        );
      });
    } finally {
      if (threadId !== undefined) {
        await bridge
          .request("thread/archive", { threadId })
          .catch(() => undefined);
      }
      await bridge.close();
    }
  }, 180_000);

  it("runs two turns on one thread and resumes the same thread", async () => {
    const liveWorkspace = requireString(workspace, "CODEX_APP_SERVER_TEST_CWD");
    const bridge = new CodexAppServerBridge({
      ...(process.env.POCKETPILOT_CODEX_COMMAND === undefined
        ? {}
        : { command: process.env.POCKETPILOT_CODEX_COMMAND }),
      cwd: liveWorkspace,
      requestTimeoutMs: 120_000,
    });
    const notifications: CodexBridgeDelivery[] = [];
    bridge.subscribe((delivery) => notifications.push(delivery));

    let threadId: string | undefined;
    try {
      await bridge.start();

      const started = asObject(
        await bridge.request("thread/start", {
          approvalPolicy: "never",
          cwd: liveWorkspace,
          ephemeral: false,
          sandbox: "read-only",
          threadSource: "pocketpilot-live-multiturn",
        }),
      );
      threadId = requireString(asObject(started.thread).id, "thread.id");

      // Turn 1 — establish the session with a marker prompt.
      const firstTurnOffset = notifications.length;
      await bridge.request("turn/start", {
        approvalPolicy: "never",
        input: [
          {
            text: "POCKETPILOT_LIVE_TEST TURN_1. Reply briefly and do not use tools.",
            text_elements: [],
            type: "text",
          },
        ],
        sandboxPolicy: { type: "readOnly" },
        threadId,
      });
      await waitForNotification(
        notifications,
        (delivery) =>
          delivery.frame.method === "turn/completed" &&
          isObject(delivery.frame.params) &&
          delivery.frame.params.threadId === threadId,
        firstTurnOffset,
      );

      // Turn 2 — reuse the same thread to prove multi-turn continuity.
      const secondTurnOffset = notifications.length;
      await bridge.request("turn/start", {
        approvalPolicy: "never",
        input: [
          {
            text: "POCKETPILOT_LIVE_TEST TURN_2. Reply briefly and do not use tools.",
            text_elements: [],
            type: "text",
          },
        ],
        sandboxPolicy: { type: "readOnly" },
        threadId,
      });
      await waitForNotification(
        notifications,
        (delivery) =>
          delivery.frame.method === "turn/completed" &&
          isObject(delivery.frame.params) &&
          delivery.frame.params.threadId === threadId,
        secondTurnOffset,
      );
      expect(
        notifications
          .slice(secondTurnOffset)
          .some(
            (delivery) => delivery.frame.method === "item/agentMessage/delta",
          ),
      ).toBe(true);

      // History should record both turns on the one thread.
      const turns = asObject(
        await bridge.request("thread/turns/list", {
          itemsView: "full",
          limit: 50,
          sortDirection: "desc",
          threadId,
        }),
      );
      expect(Array.isArray(turns.data)).toBe(true);
      expect((turns.data as unknown[]).length).toBeGreaterThanOrEqual(2);

      // Resume must return the same thread identity.
      const resumed = asObject(
        await bridge.request("thread/resume", {
          excludeTurns: true,
          threadId,
        }),
      );
      expect(requireString(asObject(resumed.thread).id, "thread.id")).toBe(
        threadId,
      );
    } finally {
      if (threadId !== undefined) {
        await bridge
          .request("thread/archive", { threadId })
          .catch(() => undefined);
      }
      await bridge.close();
    }
  }, 180_000);

  it("probes readiness and projects a safe discovery descriptor", async () => {
    const command =
      process.env.POCKETPILOT_CODEX_COMMAND ??
      readCodexCommand(process.env) ??
      "codex";
    expect(isCodexCommandAvailable(command)).toBe(true);

    const snapshot = await probeCodexReadiness({
      command,
      probeTimeoutMs: 30_000,
    });
    expect(snapshot).toEqual({
      protocolVersion: expect.stringMatching(/^codex-app-server@/u),
      status: "available",
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret=");
    expect(JSON.stringify(snapshot)).not.toContain("ENOENT");

    const adapter = new CodexProviderAdapter({
      bridge: {
        subscribe() {
          return () => undefined;
        },
      } as never,
      command,
      repository: {} as never,
      taskRuntime: {} as never,
      async probeReadiness() {
        return snapshot;
      },
    });
    await adapter.refreshReadiness({ force: true });
    expect(adapter.descriptor.status).toBe("available");
    expect(adapter.descriptor.protocolVersion).toMatch(/^codex-app-server@/u);
    expect(adapter.descriptor.reasonCode).toBeUndefined();
    expect(JSON.stringify(adapter.descriptor)).not.toContain("secret");
    expect(JSON.stringify(adapter.descriptor)).not.toContain("ENOENT");
    expect(JSON.stringify(adapter.descriptor)).not.toContain("stderr");
  }, 60_000);

  it("covers status catalogs, list filters, rename, fork, and disposable cleanup", async () => {
    const liveWorkspace = requireString(workspace, "CODEX_APP_SERVER_TEST_CWD");
    const bridge = new CodexAppServerBridge({
      ...(process.env.POCKETPILOT_CODEX_COMMAND === undefined
        ? {}
        : { command: process.env.POCKETPILOT_CODEX_COMMAND }),
      cwd: liveWorkspace,
      requestTimeoutMs: 120_000,
    });

    let primaryThreadId: string | undefined;
    let forkedThreadId: string | undefined;
    try {
      await bridge.start();

      // Readonly status catalogs (no refreshToken, no mutation routes).
      // Live bridge returns native payloads; PocketPilot projection is unit-
      // tested separately. Still assert no obvious secret fields in raw rows.
      const account = asObject(
        await bridge.request("account/read", { refreshToken: false }),
      );
      expect(account).toBeDefined();
      const accountJson = JSON.stringify(account);
      // Auth mode labels such as account.type="apiKey" are allowed; only secret
      // field values / token material must stay out of the live payload.
      expect(accountJson).not.toMatch(/refreshToken/iu);
      expect(accountJson).not.toMatch(/"accessToken"\s*:/iu);
      expect(accountJson).not.toMatch(/"apiKey"\s*:\s*"/iu);

      // ChatGPT-backed rate limits are unavailable on pure apiKey auth.
      // Treat the official "chatgpt authentication required" rejection as an
      // expected soft skip; any other rejection remains a hard failure.
      try {
        const rateLimits = asObject(
          await bridge.request("account/rateLimits/read", {}),
        );
        expect(rateLimits).toBeDefined();
      } catch (error) {
        if (!isExpectedRateLimitsAuthError(error, account)) {
          throw error;
        }
      }

      const skills = asObject(
        await bridge.request("skills/list", { cwds: [liveWorkspace] }),
      );
      expect(skills).toBeDefined();

      const hooks = asObject(
        await bridge.request("hooks/list", { cwds: [liveWorkspace] }),
      );
      expect(hooks).toBeDefined();

      const mcpServers = asObject(
        await bridge.request("mcpServerStatus/list", {}),
      );
      expect(mcpServers).toBeDefined();

      const started = asObject(
        await bridge.request("thread/start", {
          approvalPolicy: "never",
          cwd: liveWorkspace,
          ephemeral: false,
          sandbox: "read-only",
          threadSource: "pocketpilot-live-thread-mgmt",
        }),
      );
      primaryThreadId = requireString(asObject(started.thread).id, "thread.id");

      await expect(
        bridge.request("thread/name/set", {
          name: "pocketpilot-live-renamed",
          threadId: primaryThreadId,
        }),
      ).resolves.toBeDefined();

      const listedWithSearch = asObject(
        await bridge.request("thread/list", {
          cwd: liveWorkspace,
          limit: 20,
          searchTerm: "pocketpilot-live-renamed",
          sourceKinds: ["cli", "vscode", "appServer"],
        }),
      );
      expect(Array.isArray(listedWithSearch.data)).toBe(true);

      // Fork creates the only disposable mutation target for archive/delete.
      const forked = asObject(
        await bridge.request("thread/fork", {
          threadId: primaryThreadId,
        }),
      );
      forkedThreadId = requireString(asObject(forked.thread).id, "thread.id");
      expect(forkedThreadId).not.toBe(primaryThreadId);

      await expect(
        bridge.request("thread/archive", { threadId: forkedThreadId }),
      ).resolves.toBeDefined();

      const listedArchived = asObject(
        await bridge.request("thread/list", {
          archived: true,
          cwd: liveWorkspace,
          limit: 50,
          sourceKinds: ["cli", "vscode", "appServer"],
        }),
      );
      expect(Array.isArray(listedArchived.data)).toBe(true);

      // Codex 0.144 on Windows can fail unarchive with a thread-store internal
      // error after archive. Treat that known upstream failure as a soft skip and
      // continue disposable cleanup via delete.
      try {
        await bridge.request("thread/unarchive", { threadId: forkedThreadId });
      } catch (error) {
        if (!isExpectedThreadUnarchiveError(error)) {
          throw error;
        }
      }

      await expect(
        bridge.request("thread/delete", {
          threadId: forkedThreadId,
        }),
      ).resolves.toBeDefined();
      forkedThreadId = undefined;

      await expect(
        bridge.request("thread/delete", {
          threadId: primaryThreadId,
        }),
      ).resolves.toBeDefined();
      primaryThreadId = undefined;
    } finally {
      if (forkedThreadId !== undefined) {
        await bridge
          .request("thread/delete", { threadId: forkedThreadId })
          .catch(() => undefined);
      }
      if (primaryThreadId !== undefined) {
        await bridge
          .request("thread/delete", { threadId: primaryThreadId })
          .catch(() => undefined);
      }
      await bridge.close();
    }
  }, 180_000);
});

function isObject(value: unknown): value is CodexJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): CodexJsonObject {
  if (!isObject(value)) {
    throw new Error("The live Codex response was not an object.");
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The live Codex response did not include ${field}.`);
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isExpectedRateLimitsAuthError(
  error: unknown,
  accountPayload: CodexJsonObject,
): boolean {
  // account/read returns { account: { type: "apiKey" | "chatgpt" | ... }, ... }.
  // Pure apiKey auth has no ChatGPT session. Codex rejects rate-limit reads
  // with "chatgpt authentication required to read rate limits". Soft-skip only
  // that expected auth rejection; ChatGPT-auth accounts still hard-fail.
  const nested = isObject(accountPayload.account)
    ? accountPayload.account
    : accountPayload;
  if (nested.type !== "apiKey") {
    return false;
  }
  return (
    error instanceof Error &&
    /chatgpt authentication required to read rate limits/iu.test(error.message)
  );
}

function isExpectedThreadUnarchiveError(error: unknown): boolean {
  // Observed on Codex 0.144 Windows: archive succeeds, then unarchive fails
  // with thread-store internal error while reading the restored rollout.
  return (
    error instanceof Error &&
    /failed to unarchive session|thread-store internal error/iu.test(
      error.message,
    )
  );
}

async function waitForNotification(
  notifications: CodexBridgeDelivery[],
  predicate: (delivery: CodexBridgeDelivery) => boolean,
  fromIndex = 0,
): Promise<CodexBridgeDelivery> {
  const deadline = Date.now() + 120_000;
  while (true) {
    const delivery = notifications.slice(fromIndex).find(predicate);
    if (delivery !== undefined) {
      return delivery;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the live Codex turn.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
