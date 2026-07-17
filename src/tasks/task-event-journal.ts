import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type BetterSqlite3 from "better-sqlite3";

import {
  createEncryptionContext,
  decryptText,
  encryptText,
  parseEncryptedValueEnvelope,
} from "../storage/crypto.js";
import type {
  TaskControlEvent,
  TaskControlEventEnvelope,
  TaskControlEventSubscriber,
  TaskEventSink,
  TaskSdkMessageSubscriber,
} from "./task-events.js";
import { taskControlEventEnvelopeSchema } from "./task-events.js";

const DEFAULT_MEMORY_THRESHOLD_BYTES = 64 * 1024;
const DEFAULT_REPLAY_LIMIT_BYTES = 256 * 1024 * 1024;

type RetainedTaskRecord =
  | {
      channel: "control";
      envelope: TaskControlEventEnvelope;
      storageCursor: number;
    }
  | {
      channel: "sdk";
      message: SDKMessage;
      storageCursor: number;
    };

type ActiveTaskJournal = {
  controlSubscribers: Set<TaskControlEventSubscriber>;
  memory: RetainedTaskRecord[];
  memoryBytes: number;
  nextControlCursor: number;
  nextStorageCursor: number;
  overflowStarted: boolean;
  replayBytes: number;
  retentionStopped: boolean;
  sdkCursorByUuid: Map<string, number>;
  sdkSubscribers: Set<TaskSdkMessageSubscriber>;
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
 * Separately delivers raw SDK messages and PocketPilot control events while
 * retaining only the active turn for reconnect. Overflow is encrypted
 * temporary transport data, never a canonical conversation transcript.
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
    journal.nextStorageCursor = 0;
    journal.overflowStarted = false;
    journal.replayBytes = 0;
    journal.retentionStopped = false;
    journal.sdkCursorByUuid.clear();
    journal.turnActive = true;
    this.deleteOverflow(taskId);
  }

  public endTurn(taskId: string): void {
    const journal = this.#journals.get(taskId);
    if (journal === undefined) {
      return;
    }
    journal.memory = [];
    journal.memoryBytes = 0;
    journal.nextStorageCursor = 0;
    journal.overflowStarted = false;
    journal.replayBytes = 0;
    journal.retentionStopped = false;
    journal.sdkCursorByUuid.clear();
    journal.turnActive = false;
    this.deleteOverflow(taskId);
  }

  public publishControlEvent(
    taskId: string,
    event: TaskControlEvent,
  ): TaskControlEventEnvelope {
    const journal = this.journal(taskId);
    const envelope: TaskControlEventEnvelope = {
      cursor: journal.nextControlCursor,
      event,
      occurredAt: this.#now(),
      taskId,
    };
    journal.nextControlCursor += 1;
    this.deliverControl(journal, envelope);
    this.retain(taskId, journal, {
      channel: "control",
      envelope,
      storageCursor: journal.nextStorageCursor,
    });
    return envelope;
  }

  public publishSdkMessage(taskId: string, message: SDKMessage): void {
    const journal = this.journal(taskId);
    this.deliverSdk(journal, message);
    this.retain(taskId, journal, {
      channel: "sdk",
      message,
      storageCursor: journal.nextStorageCursor,
    });
  }

  public subscribeControl(
    taskId: string,
    afterCursor: number,
    subscriber: TaskControlEventSubscriber,
  ): () => void {
    const journal = this.journal(taskId);
    const replay = this.readReplay(taskId, journal)
      .filter(
        (
          record,
        ): record is Extract<RetainedTaskRecord, { channel: "control" }> =>
          record.channel === "control" && record.envelope.cursor > afterCursor,
      )
      .map((record) => record.envelope);
    journal.controlSubscribers.add(subscriber);
    for (const event of replay) {
      subscriber.send(event);
    }
    return () => journal.controlSubscribers.delete(subscriber);
  }

  public subscribeSdk(
    taskId: string,
    afterUuid: string | undefined,
    subscriber: TaskSdkMessageSubscriber,
  ): () => void {
    const journal = this.journal(taskId);
    const afterStorageCursor =
      afterUuid === undefined
        ? undefined
        : journal.sdkCursorByUuid.get(afterUuid);
    const replay = this.readReplay(taskId, journal)
      .filter(
        (record): record is Extract<RetainedTaskRecord, { channel: "sdk" }> =>
          record.channel === "sdk" &&
          (afterStorageCursor === undefined ||
            record.storageCursor > afterStorageCursor),
      )
      .map((record) => record.message);
    journal.sdkSubscribers.add(subscriber);
    for (const message of replay) {
      subscriber.send(message);
    }
    return () => journal.sdkSubscribers.delete(subscriber);
  }

  private deleteOverflow(taskId: string): void {
    this.options.sqlite
      .prepare("DELETE FROM event_overflow WHERE task_id = ?")
      .run(taskId);
  }

  private deliverControl(
    journal: ActiveTaskJournal,
    event: TaskControlEventEnvelope,
  ): void {
    for (const subscriber of journal.controlSubscribers) {
      subscriber.send(event);
    }
  }

  private deliverSdk(journal: ActiveTaskJournal, message: SDKMessage): void {
    for (const subscriber of journal.sdkSubscribers) {
      subscriber.send(message);
    }
  }

  private journal(taskId: string): ActiveTaskJournal {
    let journal = this.#journals.get(taskId);
    if (journal === undefined) {
      journal = {
        controlSubscribers: new Set(),
        memory: [],
        memoryBytes: 0,
        nextControlCursor: 0,
        nextStorageCursor: 0,
        overflowStarted: false,
        replayBytes: 0,
        retentionStopped: false,
        sdkCursorByUuid: new Map(),
        sdkSubscribers: new Set(),
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
    const limitEvent: TaskControlEventEnvelope = {
      cursor: journal.nextControlCursor,
      event: {
        kind: "event.replay-storage-limit-reached",
        payload: { code: "EVENT_REPLAY_STORAGE_LIMIT_REACHED" },
      },
      occurredAt: this.#now(),
      taskId,
    };
    journal.nextControlCursor += 1;
    this.deliverControl(journal, limitEvent);
  }

  private retain(
    taskId: string,
    journal: ActiveTaskJournal,
    record: RetainedTaskRecord,
  ): void {
    if (!journal.turnActive || journal.retentionStopped) {
      return;
    }

    const serialized = JSON.stringify(record);
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (journal.replayBytes + byteLength > this.#replayLimitBytes) {
      journal.retentionStopped = true;
      this.publishReplayLimitReached(taskId, journal);
      return;
    }

    journal.nextStorageCursor += 1;
    journal.replayBytes += byteLength;
    if (record.channel === "sdk") {
      const uuid = sdkMessageUuid(record.message);
      if (uuid !== undefined) {
        journal.sdkCursorByUuid.set(uuid, record.storageCursor);
      }
    }

    if (
      !journal.overflowStarted &&
      journal.memoryBytes + byteLength <= this.#memoryThresholdBytes
    ) {
      journal.memory.push(record);
      journal.memoryBytes += byteLength;
      return;
    }

    journal.overflowStarted = true;
    const encrypted = encryptText(
      this.#masterKey,
      createEncryptionContext({
        column: "payload_envelope",
        recordId: `${taskId}:${record.storageCursor}`,
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
        record.storageCursor,
        JSON.stringify(encrypted),
        byteLength,
        this.#now(),
      );
  }

  private readReplay(
    taskId: string,
    journal: ActiveTaskJournal,
  ): RetainedTaskRecord[] {
    const overflowRows = this.options.sqlite
      .prepare<[string], { cursor: number; payloadEnvelope: string }>(
        "SELECT cursor, payload_envelope AS payloadEnvelope FROM event_overflow WHERE task_id = ? ORDER BY cursor ASC",
      )
      .all(taskId);
    const overflow = overflowRows.map((row) =>
      this.decryptRecord(taskId, row.cursor, row.payloadEnvelope),
    );
    return [...journal.memory, ...overflow].sort(
      (left, right) => left.storageCursor - right.storageCursor,
    );
  }

  private decryptRecord(
    taskId: string,
    cursor: number,
    payloadEnvelope: string,
  ): RetainedTaskRecord {
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
    return parseRetainedRecord(parsed, cursor);
  }
}

function parseRetainedRecord(
  value: unknown,
  expectedCursor: number,
): RetainedTaskRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("channel" in value) ||
    !("storageCursor" in value) ||
    value.storageCursor !== expectedCursor
  ) {
    throw new Error("An event overflow record is invalid.");
  }

  if (value.channel === "control" && "envelope" in value) {
    return {
      channel: "control",
      envelope: taskControlEventEnvelopeSchema.parse(value.envelope),
      storageCursor: expectedCursor,
    };
  }

  if (
    value.channel === "sdk" &&
    "message" in value &&
    typeof value.message === "object" &&
    value.message !== null &&
    "type" in value.message &&
    typeof value.message.type === "string"
  ) {
    return {
      channel: "sdk",
      message: value.message as SDKMessage,
      storageCursor: expectedCursor,
    };
  }

  throw new Error("An event overflow record is invalid.");
}

function sdkMessageUuid(message: SDKMessage): string | undefined {
  return "uuid" in message && typeof message.uuid === "string"
    ? message.uuid
    : undefined;
}
