import { describe, expect, it } from "vitest";

import { CodexAppServerBridge } from "../../src/codex-app-server/bridge.js";
import type {
  CodexBridgeDelivery,
  CodexJsonObject,
} from "../../src/codex-app-server/types.js";

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
      expect(requireString(thread.cwd, "thread.cwd")).toBe(liveWorkspace);

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
