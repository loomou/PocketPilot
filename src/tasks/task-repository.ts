import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne } from "drizzle-orm";
import type { StorageDatabase } from "../storage/database.js";
import { StorageDataError } from "../storage/errors.js";
import { auditRecords, operationResults, tasks } from "../storage/schema.js";
import {
  type TaskOperationResult,
  type TaskSnapshot,
  type TaskState,
  taskOperationResultSchema,
  taskStateSchema,
} from "./task-types.js";

type TaskUpdate = {
  interruptedAt?: number | null;
  model?: string | null;
  permissionMode?: string;
  sdkSessionId?: string | null;
  state?: TaskState;
  terminalAt?: number | null;
  updatedAt: number;
};

type PersistOperationInput = {
  deviceId: string;
  expiresAt: number;
  operation: string;
  operationId: string;
  result: TaskOperationResult;
  resultLabel: string;
  taskId: string;
};

/** Owns task metadata, operation-id results, and metadata-only audit rows. */
export class TaskRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public countActiveTasks(): number {
    const row = this.database
      .select({ count: tasks.id })
      .from(tasks)
      .where(inArray(tasks.state, ["executing", "awaiting_approval"]))
      .all();
    return row.length;
  }

  public create(input: {
    createdAt: number;
    id: string;
    initialCwd: string;
    model: string | null;
    permissionMode: string;
  }): TaskSnapshot {
    this.database
      .insert(tasks)
      .values({
        createdAt: input.createdAt,
        id: input.id,
        initialCwd: input.initialCwd,
        model: input.model,
        permissionMode: input.permissionMode,
        state: "idle",
        updatedAt: input.createdAt,
      })
      .run();

    return this.require(input.id);
  }

  public find(id: string): TaskSnapshot | undefined {
    const row = this.database
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();
    return row === undefined ? undefined : parseTaskRow(row);
  }

  public list(): TaskSnapshot[] {
    return this.database
      .select()
      .from(tasks)
      .orderBy(tasks.createdAt)
      .all()
      .map(parseTaskRow);
  }

  public markActiveTasksInterrupted(now: number): number {
    return this.database
      .update(tasks)
      .set({
        interruptedAt: now,
        state: "interrupted",
        updatedAt: now,
      })
      .where(inArray(tasks.state, ["executing", "awaiting_approval"]))
      .run().changes;
  }

  public markNonTerminalTasksTerminal(now: number): number {
    return this.database
      .update(tasks)
      .set({
        state: "terminal",
        terminalAt: now,
        updatedAt: now,
      })
      .where(ne(tasks.state, "terminal"))
      .run().changes;
  }

  public persistOperation(input: PersistOperationInput): TaskOperationResult {
    return this.database.transaction((transaction) => {
      const existing = transaction
        .select({ resultJson: operationResults.resultJson })
        .from(operationResults)
        .where(
          and(
            eq(operationResults.deviceId, input.deviceId),
            eq(operationResults.operationId, input.operationId),
          ),
        )
        .get();
      if (existing !== undefined) {
        return parseOperationResult(existing.resultJson);
      }

      transaction
        .insert(operationResults)
        .values({
          createdAt: Date.now(),
          deviceId: input.deviceId,
          expiresAt: input.expiresAt,
          operationId: input.operationId,
          resultJson: JSON.stringify(input.result),
        })
        .run();
      transaction
        .insert(auditRecords)
        .values({
          deviceId: input.deviceId,
          id: randomUUID(),
          occurredAt: Date.now(),
          operation: input.operation,
          result: input.resultLabel,
          taskId: input.taskId,
        })
        .run();
      return input.result;
    });
  }

  public readOperation(
    deviceId: string,
    operationId: string,
  ): TaskOperationResult | undefined {
    const row = this.database
      .select({ resultJson: operationResults.resultJson })
      .from(operationResults)
      .where(
        and(
          eq(operationResults.deviceId, deviceId),
          eq(operationResults.operationId, operationId),
        ),
      )
      .get();
    return row === undefined ? undefined : parseOperationResult(row.resultJson);
  }

  public recordAudit(input: {
    deviceId: string;
    occurredAt: number;
    operation: string;
    result: string;
    taskId: string;
  }): void {
    this.database
      .insert(auditRecords)
      .values({
        deviceId: input.deviceId,
        id: randomUUID(),
        occurredAt: input.occurredAt,
        operation: input.operation,
        result: input.result,
        taskId: input.taskId,
      })
      .run();
  }

  public require(id: string): TaskSnapshot {
    const task = this.find(id);
    if (task === undefined) {
      throw new StorageDataError(`Task '${id}' is missing after persistence.`);
    }
    return task;
  }

  public update(id: string, update: TaskUpdate): TaskSnapshot {
    this.database.update(tasks).set(update).where(eq(tasks.id, id)).run();
    return this.require(id);
  }
}

function parseOperationResult(valueJson: string): TaskOperationResult {
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    throw new StorageDataError("An operation result contains invalid JSON.");
  }

  const result = taskOperationResultSchema.safeParse(value);
  if (!result.success) {
    throw new StorageDataError(
      "An operation result does not match its schema.",
    );
  }
  return result.data;
}

function parseTaskRow(row: typeof tasks.$inferSelect): TaskSnapshot {
  const state = taskStateSchema.safeParse(row.state);
  if (!state.success) {
    throw new StorageDataError(
      "A task contains an unsupported lifecycle state.",
    );
  }

  return {
    createdAt: row.createdAt,
    id: row.id,
    initialCwd: row.initialCwd,
    interruptedAt: row.interruptedAt,
    model: row.model,
    permissionMode: row.permissionMode,
    sdkSessionId: row.sdkSessionId,
    state: state.data,
    terminalAt: row.terminalAt,
    updatedAt: row.updatedAt,
  };
}
