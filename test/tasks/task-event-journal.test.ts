import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  openStorage,
  type StorageConnection,
} from "../../src/storage/database.js";
import { TaskEventJournal } from "../../src/tasks/task-event-journal.js";
import type { TaskControlEventEnvelope } from "../../src/tasks/task-events.js";

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

  it("replays raw SDK messages after a known UUID and continues live delivery", () => {
    const fixture = createFixture(connections, temporaryDirectories);
    const journal = new TaskEventJournal({
      masterKey: fixture.masterKey,
      sqlite: fixture.connection.sqlite,
    });
    const taskId = fixture.createTask();
    const first = sdkMessage(0, "00000000-0000-0000-0000-000000000001");
    const withoutUuid = sdkMessage(1);
    const third = sdkMessage(2, "00000000-0000-0000-0000-000000000003");

    journal.beginTurn(taskId);
    journal.publishSdkMessage(taskId, first);
    journal.publishControlEvent(taskId, {
      kind: "task.state",
      payload: { state: "executing" },
    });
    journal.publishSdkMessage(taskId, withoutUuid);
    journal.publishSdkMessage(taskId, third);

    const received: SDKMessage[] = [];
    const unsubscribe = journal.subscribeSdk(
      taskId,
      "00000000-0000-0000-0000-000000000001",
      {
        send(message): void {
          received.push(message);
        },
      },
    );
    const live = sdkMessage(3, "00000000-0000-0000-0000-000000000004");
    journal.publishSdkMessage(taskId, live);

    expect(received).toEqual([withoutUuid, third, live]);
    expect(received[0]).toBe(withoutUuid);
    unsubscribe();
  });

  it("replays the current turn from the beginning for missing or unknown UUIDs", () => {
    const fixture = createFixture(connections, temporaryDirectories);
    const journal = new TaskEventJournal({
      masterKey: fixture.masterKey,
      sqlite: fixture.connection.sqlite,
    });
    const taskId = fixture.createTask();
    const messages = [
      sdkMessage(0, "00000000-0000-0000-0000-000000000001"),
      sdkMessage(1),
    ];

    journal.beginTurn(taskId);
    for (const message of messages) {
      journal.publishSdkMessage(taskId, message);
    }

    const missing: SDKMessage[] = [];
    journal.subscribeSdk(taskId, undefined, {
      send(message): void {
        missing.push(message);
      },
    });
    const unknown: SDKMessage[] = [];
    journal.subscribeSdk(taskId, "unknown-sdk-uuid", {
      send(message): void {
        unknown.push(message);
      },
    });

    expect(missing).toEqual(messages);
    expect(unknown).toEqual(messages);
  });

  it("keeps SDK and control delivery isolated", () => {
    const fixture = createFixture(connections, temporaryDirectories);
    const journal = new TaskEventJournal({
      masterKey: fixture.masterKey,
      sqlite: fixture.connection.sqlite,
    });
    const taskId = fixture.createTask();
    const sdk = sdkMessage(0, "00000000-0000-0000-0000-000000000001");

    journal.beginTurn(taskId);
    journal.publishSdkMessage(taskId, sdk);
    journal.publishControlEvent(taskId, {
      kind: "task.state",
      payload: { state: "executing" },
    });

    const sdkReplay: SDKMessage[] = [];
    const controlReplay: TaskControlEventEnvelope[] = [];
    journal.subscribeSdk(taskId, undefined, {
      send(message): void {
        sdkReplay.push(message);
      },
    });
    journal.subscribeControl(taskId, -1, {
      send(event): void {
        controlReplay.push(event);
      },
    });

    expect(sdkReplay).toEqual([sdk]);
    expect(controlReplay.map((event) => event.event.kind)).toEqual([
      "task.state",
    ]);
    expect(controlReplay[0]).not.toHaveProperty("message");
  });

  it("does not cross-deliver SDK messages between tasks", () => {
    const fixture = createFixture(connections, temporaryDirectories);
    const journal = new TaskEventJournal({
      masterKey: fixture.masterKey,
      sqlite: fixture.connection.sqlite,
    });
    const firstTask = fixture.createTask();
    const secondTask = fixture.createTask();
    const firstMessage = sdkMessage(1, "00000000-0000-0000-0000-000000000001");
    const secondMessage = sdkMessage(2, "00000000-0000-0000-0000-000000000002");

    journal.beginTurn(firstTask);
    journal.beginTurn(secondTask);
    journal.publishSdkMessage(firstTask, firstMessage);
    journal.publishSdkMessage(secondTask, secondMessage);
    const firstReplay: SDKMessage[] = [];
    const secondReplay: SDKMessage[] = [];
    journal.subscribeSdk(firstTask, undefined, {
      send(message): void {
        firstReplay.push(message);
      },
    });
    journal.subscribeSdk(secondTask, undefined, {
      send(message): void {
        secondReplay.push(message);
      },
    });

    expect(firstReplay).toEqual([firstMessage]);
    expect(secondReplay).toEqual([secondMessage]);
  });

  it("encrypts overflow and deletes all replay data when the turn ends", () => {
    const fixture = createFixture(connections, temporaryDirectories);
    const journal = new TaskEventJournal({
      masterKey: fixture.masterKey,
      memoryThresholdBytes: 1,
      sqlite: fixture.connection.sqlite,
    });
    const taskId = fixture.createTask();
    const message = {
      ...sdkMessage(0, "00000000-0000-0000-0000-000000000001"),
      private_extension: "model output that must not be stored as plaintext",
    } as unknown as SDKMessage;

    journal.beginTurn(taskId);
    journal.publishSdkMessage(taskId, message);

    const row = fixture.connection.sqlite
      .prepare<[], { payloadEnvelope: string }>(
        "SELECT payload_envelope AS payloadEnvelope FROM event_overflow",
      )
      .get();
    expect(row?.payloadEnvelope).not.toContain("model output");
    const replay: SDKMessage[] = [];
    journal.subscribeSdk(taskId, undefined, {
      send(replayed): void {
        replay.push(replayed);
      },
    });
    expect(replay).toEqual([message]);

    journal.endTurn(taskId);
    expect(
      fixture.connection.sqlite
        .prepare("SELECT COUNT(*) AS count FROM event_overflow")
        .get(),
    ).toEqual({ count: 0 });
    const afterCleanup: SDKMessage[] = [];
    journal.subscribeSdk(taskId, undefined, {
      send(replayed): void {
        afterCleanup.push(replayed);
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
    const sdkLive: SDKMessage[] = [];
    const controlLive: TaskControlEventEnvelope[] = [];
    const message = sdkMessage(0, "00000000-0000-0000-0000-000000000001");

    journal.beginTurn(taskId);
    journal.subscribeSdk(taskId, undefined, {
      send(event): void {
        sdkLive.push(event);
      },
    });
    journal.subscribeControl(taskId, -1, {
      send(event): void {
        controlLive.push(event);
      },
    });
    journal.publishSdkMessage(taskId, message);

    expect(sdkLive).toEqual([message]);
    expect(controlLive.map((event) => event.event.kind)).toEqual([
      "event.replay-storage-limit-reached",
    ]);
    const replay: SDKMessage[] = [];
    journal.subscribeSdk(taskId, undefined, {
      send(event): void {
        replay.push(event);
      },
    });
    expect(replay).toEqual([]);
  });
});

function sdkMessage(sequence: number, uuid?: string): SDKMessage {
  return {
    type: "user",
    message: { role: "user", content: `message-${sequence}` },
    parent_tool_use_id: null,
    ...(uuid === undefined ? {} : { uuid }),
    passthrough_extension: { sequence },
  } as SDKMessage;
}

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
