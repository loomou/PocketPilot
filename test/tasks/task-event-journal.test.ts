import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { TaskEventJournal } from "../../src/tasks/task-event-journal.js";
import type { TaskEventEnvelope } from "../../src/tasks/task-events.js";

describe("TaskEventJournal", () => {
  const connections: StorageConnection[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("replays retained memory events before continuing live delivery", () => {
    const fixture = createFixture(connections, temporaryDirectories);
    const journal = new TaskEventJournal({
      masterKey: fixture.masterKey,
      sqlite: fixture.connection.sqlite,
    });
    const taskId = fixture.createTask();

    journal.beginTurn(taskId);
    journal.publish(taskId, { kind: "sdk", payload: { sequence: 0 } });
    journal.publish(taskId, { kind: "sdk", payload: { sequence: 1 } });
    const received: TaskEventEnvelope[] = [];
    const unsubscribe = journal.subscribe(taskId, 0, {
      send(event): void {
        received.push(event);
      },
    });
    journal.publish(taskId, { kind: "sdk", payload: { sequence: 2 } });

    expect(received.map((event) => event.cursor)).toEqual([1, 2]);
    unsubscribe();
  });

  it("encrypts overflow and deletes all replay data when the turn ends", () => {
    const fixture = createFixture(connections, temporaryDirectories);
    const journal = new TaskEventJournal({
      masterKey: fixture.masterKey,
      memoryThresholdBytes: 1,
      sqlite: fixture.connection.sqlite,
    });
    const taskId = fixture.createTask();
    const payload = "model output that must not be stored as plaintext";

    journal.beginTurn(taskId);
    journal.publish(taskId, { kind: "sdk", payload });

    const row = fixture.connection.sqlite
      .prepare<[], { payloadEnvelope: string }>(
        "SELECT payload_envelope AS payloadEnvelope FROM event_overflow",
      )
      .get();
    expect(row?.payloadEnvelope).not.toContain(payload);
    const replay: TaskEventEnvelope[] = [];
    journal.subscribe(taskId, -1, {
      send(event): void {
        replay.push(event);
      },
    });
    expect(replay[0]?.event).toEqual({ kind: "sdk", payload });

    journal.endTurn(taskId);
    expect(
      fixture.connection.sqlite
        .prepare("SELECT COUNT(*) AS count FROM event_overflow")
        .get(),
    ).toEqual({ count: 0 });
    const afterCleanup: TaskEventEnvelope[] = [];
    journal.subscribe(taskId, -1, {
      send(event): void {
        afterCleanup.push(event);
      },
    });
    expect(afterCleanup).toEqual([]);
  });

  it("keeps live delivery after the replay cap while stopping retention", () => {
    const fixture = createFixture(connections, temporaryDirectories);
    const journal = new TaskEventJournal({
      masterKey: fixture.masterKey,
      replayLimitBytes: 1,
      sqlite: fixture.connection.sqlite,
    });
    const taskId = fixture.createTask();
    const live: TaskEventEnvelope[] = [];

    journal.beginTurn(taskId);
    journal.subscribe(taskId, -1, {
      send(event): void {
        live.push(event);
      },
    });
    journal.publish(taskId, { kind: "sdk", payload: "still live" });

    expect(live.map((event) => event.event.kind)).toEqual([
      "sdk",
      "event.replay-storage-limit-reached",
    ]);
    const replay: TaskEventEnvelope[] = [];
    journal.subscribe(taskId, -1, {
      send(event): void {
        replay.push(event);
      },
    });
    expect(replay).toEqual([]);
  });
});

function createFixture(
  connections: StorageConnection[],
  temporaryDirectories: string[],
): {
  connection: StorageConnection;
  createTask(): string;
  masterKey: Buffer;
} {
  const directory = mkdtempSync(join(tmpdir(), "pocketpilot-events-"));
  const connection = openStorage({
    databasePath: join(directory, "agent.sqlite"),
  });
  connections.push(connection);
  temporaryDirectories.push(directory);

  return {
    connection,
    createTask(): string {
      const taskId = randomUUID();
      connection.sqlite
        .prepare(
          "INSERT INTO tasks (id, initial_cwd, permission_mode, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(taskId, directory, "default", "executing", 1, 1);
      return taskId;
    },
    masterKey: Buffer.alloc(32, 7),
  };
}
