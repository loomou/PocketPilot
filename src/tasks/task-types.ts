import { z } from "zod";

export const taskStateSchema = z.enum([
  "idle",
  "executing",
  "awaiting_approval",
  "interrupted",
  "terminal",
]);

export type TaskState = z.infer<typeof taskStateSchema>;

export const taskSnapshotSchema = z.object({
  createdAt: z.number().int(),
  id: z.uuid(),
  initialCwd: z.string().min(1),
  interruptedAt: z.number().int().nullable(),
  model: z.string().min(1).nullable(),
  permissionMode: z.string().min(1),
  sdkSessionId: z.string().min(1).nullable(),
  state: taskStateSchema,
  terminalAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

export const taskOperationActionSchema = z.enum([
  "created",
  "interrupted",
  "closed",
  "resumed",
  "approval-approved",
  "approval-denied",
  "model-changed",
  "permission-mode-changed",
]);

export type TaskOperationAction = z.infer<typeof taskOperationActionSchema>;

/**
 * Persisted idempotency results intentionally contain only task metadata.
 * SDK messages, model output, tool inputs, and approval details stay outside
 * this table so it can never become a second Claude transcript.
 */
export const taskOperationResultSchema = z.object({
  action: taskOperationActionSchema,
  task: taskSnapshotSchema,
});

export type TaskOperationResult = z.infer<typeof taskOperationResultSchema>;
