import { z } from "zod";

export const taskStateSchema = z.enum([
  "idle",
  "executing",
  "awaiting_approval",
  "interrupted",
  "terminal",
]);

export type TaskState = z.infer<typeof taskStateSchema>;

export const taskOriginSchema = z.enum([
  "agent-conversation",
  "pocketpilot",
  "claude-session",
]);

export type TaskOrigin = z.infer<typeof taskOriginSchema>;

export const taskSnapshotSchema = z.object({
  activeTurnId: z.string().min(1).nullable(),
  createdAt: z.number().int(),
  id: z.uuid(),
  initialCwd: z.string().min(1),
  interruptedAt: z.number().int().nullable(),
  model: z.string().min(1).nullable(),
  nativeConversationId: z.string().min(1).nullable(),
  nativeProtocolVersion: z
    .string()
    .min(1)
    .default("@anthropic-ai/claude-agent-sdk@0.3.210"),
  nativeSessionId: z.string().min(1).nullable(),
  origin: taskOriginSchema.default("pocketpilot"),
  permissionMode: z.string().min(1).nullable(),
  provider: z.string().trim().min(1).max(64).default("claude"),
  sdkSessionId: z.string().min(1).nullable(),
  state: taskStateSchema,
  terminalAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

export const taskOperationActionSchema = z.enum([
  "attached",
  "created",
  "interrupted",
  "closed",
  "resumed",
  "approval-approved",
  "approval-denied",
  "model-changed",
  "permission-mode-changed",
  "effort-changed",
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
