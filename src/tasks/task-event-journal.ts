import type BetterSqlite3 from "better-sqlite3";

import {
  createEncryptionContext,
  decryptText,
  encryptText,
  parseEncryptedValueEnvelope,
} from "../storage/crypto.js";
import type {
  TaskEvent,
  TaskEventEnvelope,
  TaskEventSink,
  TaskEventSubscriber,
} from "./task-events.js";
import { taskEventEnvelopeSchema } from "./task-events.js";

const DEFAULT_MEMORY_THRESHOLD_BYTES = 64 * 1024;
const DEFAULT_REPLAY_LIMIT_BYTES = 256 * 1024 * 1024;

type ActiveTaskJournal = {
  memory: TaskEventEnvelope[];
  memoryBytes: number;
  nextCursor: number;
  overflowStarted: boolean;
  replayBytes: number;
  retentionStopped: boolean;
  subscribers: Set<TaskEventSubscriber>;
  turnActive: boolean;
};

export type TaskEventJournalOptions = {
  masterKey: Buffer;
  memoryThresholdBytes?: number;
  now?: () => number;
  replayLimitBytes?: number;
  sqlite: BetterSqlite3.Database;
};

/**
 * Delivers live task events and retains only the active turn for reconnect.
 * Overflow records are encrypted temporary transport data, never transcripts.
 */
export class TaskEventJournal implements TaskEventSink {
  readonly #journals = new Map<string, ActiveTaskJournal>();
  readonly #masterKey: Buffer;
  readonly #memoryThresholdBytes: number;
  readonly #now: () => number;
  readonly #replayLimitBytes: number;

  public constructor(private readonly options: TaskEventJournalOptions) {
    this.#masterKey = options.masterKey;
    this.#memoryThresholdBytes =
      options.memoryThresholdBytes ?? DEFAULT_MEMORY_THRESHOLD_BYTES;
    this.#now = options.now ?? Date.now;
    this.#replayLimitBytes =
      options.replayLimitBytes ?? DEFAULT_REPLAY_LIMIT_BYTES;
  }

  public beginTurn(taskId: string): void {
    const journal = this.journal(taskId);
    journal.memory = [];
    journal.memoryBytes = 0;
    journal.overflowStarted = false;
    journal.replayBytes = 0;
    journal.retentionStopped = false;
    journal.turnActive = true;
    this.options.sqlite
      .prepare("DELETE FROM event_overflow WHERE task_id = ?")
      .run(taskId);
  }

  public endTurn(taskId: string): void {
    const journal = this.#journals.get(taskId);
    if (journal === undefined) {
      return;
    }
    journal.memory = [];
    journal.memoryBytes = 0;
    journal.overflowStarted = false;
    journal.replayBytes = 0;
    journal.retentionStopped = false;
    journal.turnActive = false;
    this.options.sqlite
      .prepare("DELETE FROM event_overflow WHERE task_id = ?")
      .run(taskId);
  }

  public publish(taskId: string, event: TaskEvent): TaskEventEnvelope {
    const journal = this.journal(taskId);
    const envelope: TaskEventEnvelope = {
      cursor: journal.nextCursor,
      event,
      occurredAt: this.#now(),
      taskId,
    };
    journal.nextCursor += 1;
    this.deliver(journal, envelope);

    if (!journal.turnActive || journal.retentionStopped) {
      return envelope;
    }

    const serialized = JSON.stringify(envelope);
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (journal.replayBytes + byteLength > this.#replayLimitBytes) {
      journal.retentionStopped = true;
      this.publishReplayLimitReached(taskId, journal);
      return envelope;
    }

    journal.replayBytes += byteLength;
    if (
      !journal.overflowStarted &&
      journal.memoryBytes + byteLength <= this.#memoryThresholdBytes
    ) {
      journal.memory.push(envelope);
      journal.memoryBytes += byteLength;
      return envelope;
    }

    journal.overflowStarted = true;
    const encrypted = encryptText(
      this.#masterKey,
      createEncryptionContext({
        column: "payload_envelope",
        recordId: `${taskId}:${envelope.cursor}`,
        table: "event_overflow",
      }),
      serialized,
    );
    this.options.sqlite
      .prepare(
        "INSERT INTO event_overflow (task_id, cursor, payload_envelope, byte_length, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        taskId,
        envelope.cursor,
        JSON.stringify(encrypted),
        byteLength,
        this.#now(),
      );
    return envelope;
  }

  public subscribe(
    taskId: string,
    afterCursor: number,
    subscriber: TaskEventSubscriber,
  ): () => void {
    const journal = this.journal(taskId);
    const replay = this.readReplay(taskId, afterCursor, journal);
    journal.subscribers.add(subscriber);
    for (const event of replay) {
      subscriber.send(event);
    }
    return () => journal.subscribers.delete(subscriber);
  }

  private deliver(journal: ActiveTaskJournal, event: TaskEventEnvelope): void {
    for (const subscriber of journal.subscribers) {
      subscriber.send(event);
    }
  }

  private journal(taskId: string): ActiveTaskJournal {
    let journal = this.#journals.get(taskId);
    if (journal === undefined) {
      journal = {
        memory: [],
        memoryBytes: 0,
        nextCursor: 0,
        overflowStarted: false,
        replayBytes: 0,
        retentionStopped: false,
        subscribers: new Set(),
        turnActive: false,
      };
      this.#journals.set(taskId, journal);
    }
    return journal;
  }

  private publishReplayLimitReached(
    taskId: string,
    journal: ActiveTaskJournal,
  ): void {
    const limitEvent: TaskEventEnvelope = {
      cursor: journal.nextCursor,
      event: {
        kind: "event.replay-storage-limit-reached",
        payload: { code: "EVENT_REPLAY_STORAGE_LIMIT_REACHED" },
      },
      occurredAt: this.#now(),
      taskId,
    };
    journal.nextCursor += 1;
    this.deliver(journal, limitEvent);
  }

  private readReplay(
    taskId: string,
    afterCursor: number,
    journal: ActiveTaskJournal,
  ): TaskEventEnvelope[] {
    const memory = journal.memory.filter((event) => event.cursor > afterCursor);
    const overflowRows = this.options.sqlite
      .prepare<[string, number], { cursor: number; payloadEnvelope: string }>(
        "SELECT cursor, payload_envelope AS payloadEnvelope FROM event_overflow WHERE task_id = ? AND cursor > ? ORDER BY cursor ASC",
      )
      .all(taskId, afterCursor);
    const overflow = overflowRows.map((row) =>
      this.decryptEnvelope(taskId, row.cursor, row.payloadEnvelope),
    );
    return [...memory, ...overflow].sort(
      (left, right) => left.cursor - right.cursor,
    );
  }

  private decryptEnvelope(
    taskId: string,
    cursor: number,
    payloadEnvelope: string,
  ): TaskEventEnvelope {
    const plaintext = decryptText(
      this.#masterKey,
      createEncryptionContext({
        column: "payload_envelope",
        recordId: `${taskId}:${cursor}`,
        table: "event_overflow",
      }),
      parseEncryptedValueEnvelope(payloadEnvelope),
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error("An event overflow record contains invalid JSON.");
    }
    return taskEventEnvelopeSchema.parse(parsed);
  }
}
