import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { StorageDatabase } from "../storage/database.js";
import { StorageDataError } from "../storage/errors.js";
import {
  agentSettings,
  auditRecords,
  operationResults,
  tasks,
} from "../storage/schema.js";
import type { TaskErrorCode } from "./errors.js";
import {
  TASK_RUNTIME_SETTINGS_KEY,
  type TaskRuntimeSettings,
  taskRuntimeSettingsSchema,
} from "./settings.js";
import {
  type TaskOperationResult,
  type TaskOrigin,
  type TaskSnapshot,
  type TaskState,
  taskOperationResultSchema,
  taskOriginSchema,
  taskStateSchema,
} from "./task-types.js";

type TaskUpdate = {
  interruptedAt?: number | null;
  model?: string | null;
  origin?: TaskOrigin;
  permissionMode?: string | null;
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

type PersistOperationErrorInput = {
  createdAt: number;
  deviceId: string;
  expiresAt: number;
  operationId: string;
  taskId: string | null;
};

export type TaskOperationOutcome =
  | { kind: "error"; code: TaskErrorCode; message: string; statusCode: 409 }
  | { kind: "result"; result: TaskOperationResult };

const persistedSupersededOutcomeSchema = z.object({
  code: z.literal("TASK_OPERATION_SUPERSEDED"),
  kind: z.literal("error"),
  message: z.string(),
  statusCode: z.literal(409),
});

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
    origin: TaskOrigin;
    permissionMode: string | null;
    sdkSessionId?: string | null;
  }): TaskSnapshot {
    this.database
      .insert(tasks)
      .values({
        createdAt: input.createdAt,
        id: input.id,
        initialCwd: input.initialCwd,
        model: input.model,
        origin: input.origin,
        permissionMode: input.permissionMode,
        sdkSessionId: input.sdkSessionId ?? null,
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

  public findNonTerminalBySdkSessionId(
    sdkSessionId: string,
  ): TaskSnapshot | undefined {
    const row = this.database
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.sdkSessionId, sdkSessionId), ne(tasks.state, "terminal")),
      )
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
        const outcome = parseOperationOutcome(existing.resultJson);
        if (outcome.kind === "result") {
          return outcome.result;
        }
        throw new StorageDataError(
          "An operation error already owns this idempotency key.",
        );
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
  ): TaskOperationOutcome | undefined {
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
    return row === undefined
      ? undefined
      : parseOperationOutcome(row.resultJson);
  }

  public persistSupersededOperation(
    input: PersistOperationErrorInput,
  ): TaskOperationOutcome {
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
        return parseOperationOutcome(existing.resultJson);
      }

      const outcome = {
        code: "TASK_OPERATION_SUPERSEDED",
        kind: "error",
        message: "A higher-priority task operation superseded this request.",
        statusCode: 409,
      } as const;
      transaction
        .insert(operationResults)
        .values({
          createdAt: input.createdAt,
          deviceId: input.deviceId,
          expiresAt: input.expiresAt,
          operationId: input.operationId,
          resultJson: JSON.stringify(outcome),
        })
        .run();
      transaction
        .insert(auditRecords)
        .values({
          deviceId: input.deviceId,
          id: randomUUID(),
          occurredAt: input.createdAt,
          operation: "task.operation-superseded",
          result: "superseded",
          taskId: input.taskId,
        })
        .run();
      return outcome;
    });
  }

  public recordAudit(input: {
    deviceId: string | null;
    occurredAt: number;
    operation: string;
    result: string;
    taskId: string | null;
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

  /** Commits a workspace-policy change and its P0 task rows together. */
  public replaceWorkspaceRootsAndTerminalize(input: {
    auditResult: string;
    settings: TaskRuntimeSettings;
    taskIds: readonly string[];
    updatedAt: number;
  }): TaskSnapshot[] {
    const settings = taskRuntimeSettingsSchema.parse(input.settings);
    const valueJson = JSON.stringify(settings);
    this.database.transaction((transaction) => {
      transaction
        .insert(agentSettings)
        .values({
          key: TASK_RUNTIME_SETTINGS_KEY,
          updatedAt: input.updatedAt,
          valueJson,
        })
        .onConflictDoUpdate({
          target: agentSettings.key,
          set: { updatedAt: input.updatedAt, valueJson },
        })
        .run();

      if (input.taskIds.length > 0) {
        transaction
          .update(tasks)
          .set({
            state: "terminal",
            terminalAt: input.updatedAt,
            updatedAt: input.updatedAt,
          })
          .where(
            and(
              inArray(tasks.id, [...input.taskIds]),
              ne(tasks.state, "terminal"),
            ),
          )
          .run();
      }

      transaction
        .insert(auditRecords)
        .values({
          deviceId: null,
          id: randomUUID(),
          occurredAt: input.updatedAt,
          operation: "workspace.authorization-updated",
          result: input.auditResult,
          taskId: null,
        })
        .run();
    });

    return input.taskIds.map((taskId) => this.require(taskId));
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

function parseOperationOutcome(valueJson: string): TaskOperationOutcome {
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    throw new StorageDataError("An operation result contains invalid JSON.");
  }

  const legacyResult = taskOperationResultSchema.safeParse(value);
  if (legacyResult.success) {
    return { kind: "result", result: legacyResult.data };
  }
  const error = persistedSupersededOutcomeSchema.safeParse(value);
  if (error.success) {
    return error.data;
  }
  throw new StorageDataError("An operation result does not match its schema.");
}

function parseTaskRow(row: typeof tasks.$inferSelect): TaskSnapshot {
  const state = taskStateSchema.safeParse(row.state);
  if (!state.success) {
    throw new StorageDataError(
      "A task contains an unsupported lifecycle state.",
    );
  }
  const origin = taskOriginSchema.safeParse(row.origin);
  if (!origin.success) {
    throw new StorageDataError("A task contains an unsupported origin.");
  }

  return {
    createdAt: row.createdAt,
    id: row.id,
    initialCwd: row.initialCwd,
    interruptedAt: row.interruptedAt,
    model: row.model,
    origin: origin.data,
    permissionMode: row.permissionMode,
    sdkSessionId: row.sdkSessionId,
    state: state.data,
    terminalAt: row.terminalAt,
    updatedAt: row.updatedAt,
  };
}
