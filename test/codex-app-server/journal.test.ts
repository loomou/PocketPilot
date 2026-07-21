import { describe, expect, it } from "vitest";

import { CodexNativeJournal } from "../../src/codex-app-server/journal.js";

function checkpoint(cursor: string | null) {
  return {
    kind: "agent.checkpoint",
    payload: {
      cursor,
      provider: "codex",
    },
  };
}

describe("CodexNativeJournal", () => {
  it("emits a subscribe-time checkpoint before retained native frames", () => {
    const journal = new CodexNativeJournal();
    journal.beginTurn("task-1");
    const first = {
      method: "turn/started",
      params: { threadId: "t" },
    };
    const second = {
      method: "item/agentMessage/delta",
      params: { delta: "a" },
    };
    journal.publish("task-1", first);
    journal.publish("task-1", second);

    const empty: unknown[] = [];
    const emptyJournal = new CodexNativeJournal();
    emptyJournal.subscribe("empty", undefined, {
      send(frame) {
        empty.push(frame);
      },
    });
    expect(empty).toEqual([checkpoint(null)]);

    const known: unknown[] = [];
    journal.subscribe("task-1", "1", {
      send(frame) {
        known.push(frame);
      },
    });
    expect(known[0]).toEqual(checkpoint("2"));
    expect(known.slice(1)).toEqual([second]);
    expect(known[1]).toBe(second);
    expect(Object.hasOwn(known[1] as object, "cursor")).toBe(false);
    expect(Object.hasOwn(known[1] as object, "kind")).toBe(false);

    const missing: unknown[] = [];
    journal.subscribe("task-1", "missing", {
      send(frame) {
        missing.push(frame);
      },
    });
    expect(missing[0]).toEqual(checkpoint("2"));
    expect(missing.slice(1)).toEqual([first, second]);
    expect(missing[1]).toBe(first);
    expect(missing[2]).toBe(second);
  });

  it("replays native frames while keeping the cursor outside each frame", () => {
    const journal = new CodexNativeJournal();
    journal.beginTurn("task-1");
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
      checkpoint("2"),
      { method: "item/agentMessage/delta", params: { delta: "a" } },
    ]);
  });

  it("replays the current retained window after a stale cursor", () => {
    const journal = new CodexNativeJournal({ maxEntriesPerTask: 2 });
    journal.beginTurn("task-1");
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

    expect(replayed).toEqual([
      checkpoint("3"),
      { method: "two" },
      { method: "three" },
    ]);
  });

  it("clears retained frames at turn end without removing live subscribers", () => {
    const journal = new CodexNativeJournal();
    const received: unknown[] = [];
    journal.subscribe("task-1", undefined, {
      send(frame) {
        received.push(frame);
      },
    });
    journal.beginTurn("task-1");
    journal.publish("task-1", { method: "turn/started" });
    journal.endTurn("task-1");
    journal.publish("task-1", { method: "thread/status/changed" });

    const replayed: unknown[] = [];
    journal.subscribe("task-1", undefined, {
      send(frame) {
        replayed.push(frame);
      },
    });

    expect(received).toEqual([
      checkpoint(null),
      { method: "turn/started" },
      { method: "thread/status/changed" },
    ]);
    expect(replayed).toEqual([checkpoint(null)]);
  });
});
