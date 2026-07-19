import { describe, expect, it } from "vitest";

import { CodexNativeJournal } from "../../src/codex-app-server/journal.js";

describe("CodexNativeJournal", () => {
  it("replays native frames while keeping the cursor outside each frame", () => {
    const journal = new CodexNativeJournal();
    journal.publish("task-1", {
      method: "turn/started",
      params: { threadId: "t" },
    });
    const latest = journal.latestCursor("task-1");
    journal.publish("task-1", {
      method: "item/agentMessage/delta",
      params: { delta: "a" },
    });

    const replayed: unknown[] = [];
    journal.subscribe("task-1", latest ?? undefined, {
      send(frame) {
        replayed.push(frame);
      },
    });

    expect(replayed).toEqual([
      { method: "item/agentMessage/delta", params: { delta: "a" } },
    ]);
  });

  it("replays the current retained window after a stale cursor", () => {
    const journal = new CodexNativeJournal({ maxEntriesPerTask: 2 });
    journal.publish("task-1", { method: "one" });
    journal.publish("task-1", { method: "two" });
    const stale = "1";
    journal.publish("task-1", { method: "three" });

    const replayed: unknown[] = [];
    journal.subscribe("task-1", stale ?? undefined, {
      send(frame) {
        replayed.push(frame);
      },
    });

    expect(replayed).toEqual([{ method: "two" }, { method: "three" }]);
  });
});
