import type { AgentTaskStreamSubscriber } from "../agent-providers/types.js";
import type { CodexServerFrame } from "./types.js";

export type CodexAgentCheckpointFrame = {
  kind: "agent.checkpoint";
  payload: {
    cursor: string | null;
    provider: "codex";
  };
};

export type CodexJournalStreamFrame =
  | CodexAgentCheckpointFrame
  | CodexServerFrame;

type JournalEntry = {
  byteLength: number;
  cursor: number;
  frame: CodexServerFrame;
};

type TaskJournal = {
  byteLength: number;
  entries: JournalEntry[];
  nextCursor: number;
  subscribers: Set<AgentTaskStreamSubscriber<CodexJournalStreamFrame>>;
  turnActive: boolean;
};

export type CodexNativeJournalOptions = {
  maxBytesPerTask?: number;
  maxEntriesPerTask?: number;
};

/** Retains native Codex frames while keeping the reconnect cursor out-of-band.
 * Subscribe emits one Codex-only agent.checkpoint control frame before retained replay.
 */
export class CodexNativeJournal {
  readonly #maxBytesPerTask: number;
  readonly #maxEntriesPerTask: number;
  readonly #tasks = new Map<string, TaskJournal>();

  public constructor(options: CodexNativeJournalOptions = {}) {
    this.#maxBytesPerTask = options.maxBytesPerTask ?? 8 * 1024 * 1024;
    this.#maxEntriesPerTask = options.maxEntriesPerTask ?? 2_048;
  }

  public publish(taskId: string, frame: CodexServerFrame): string {
    const journal = this.task(taskId);
    const entry = {
      byteLength: Buffer.byteLength(JSON.stringify(frame), "utf8"),
      cursor: journal.nextCursor++,
      frame,
    };
    if (journal.turnActive) {
      journal.entries.push(entry);
      journal.byteLength += entry.byteLength;
      while (
        journal.entries.length > this.#maxEntriesPerTask ||
        journal.byteLength > this.#maxBytesPerTask
      ) {
        const removed = journal.entries.shift();
        if (removed === undefined) {
          break;
        }
        journal.byteLength -= removed.byteLength;
      }
    }
    for (const subscriber of journal.subscribers) {
      subscriber.send(frame);
    }
    return String(entry.cursor);
  }

  public beginTurn(taskId: string): void {
    const journal = this.task(taskId);
    journal.byteLength = 0;
    journal.entries = [];
    journal.turnActive = true;
  }

  public endTurn(taskId: string): void {
    const journal = this.#tasks.get(taskId);
    if (journal === undefined) {
      return;
    }
    journal.byteLength = 0;
    journal.entries = [];
    journal.turnActive = false;
  }

  public subscribe(
    taskId: string,
    afterCursor: string | undefined,
    subscriber: AgentTaskStreamSubscriber<CodexJournalStreamFrame>,
  ): () => void {
    const journal = this.task(taskId);
    subscriber.send({
      kind: "agent.checkpoint",
      payload: {
        cursor: this.latestCursor(taskId),
        provider: "codex",
      },
    });
    const parsedCursor = parseCursor(afterCursor);
    const knownCursor =
      parsedCursor !== undefined &&
      journal.entries.some((entry) => entry.cursor === parsedCursor);
    for (const entry of journal.entries) {
      if (!knownCursor || entry.cursor > parsedCursor) {
        subscriber.send(entry.frame);
      }
    }
    journal.subscribers.add(subscriber);
    return () => journal.subscribers.delete(subscriber);
  }

  public latestCursor(taskId: string): string | null {
    const journal = this.#tasks.get(taskId);
    const entry = journal?.entries.at(-1);
    return entry === undefined ? null : String(entry.cursor);
  }

  public clear(taskId: string): void {
    this.#tasks.delete(taskId);
  }

  private task(taskId: string): TaskJournal {
    let journal = this.#tasks.get(taskId);
    if (journal === undefined) {
      journal = {
        byteLength: 0,
        entries: [],
        nextCursor: 1,
        subscribers: new Set(),
        turnActive: false,
      };
      this.#tasks.set(taskId, journal);
    }
    return journal;
  }
}

function parseCursor(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}
