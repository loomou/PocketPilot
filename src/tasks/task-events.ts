import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const taskControlEventEnvelopeSchema = z.object({
  cursor: z.number().int().nonnegative(),
  event: z.object({
    kind: z.string().min(1),
    payload: z.unknown(),
  }),
  occurredAt: z.number().int(),
  taskId: z.uuid(),
});

export type TaskControlEvent = z.infer<
  typeof taskControlEventEnvelopeSchema
>["event"];
export type TaskControlEventEnvelope = z.infer<
  typeof taskControlEventEnvelopeSchema
>;

export type TaskEventSink = {
  beginTurn(taskId: string): void;
  endTurn(taskId: string): void;
  publishControlEvent(
    taskId: string,
    event: TaskControlEvent,
  ): TaskControlEventEnvelope;
  publishSdkMessage(taskId: string, message: SDKMessage): void;
};

export type TaskControlEventSubscriber = {
  send(event: TaskControlEventEnvelope): void;
};

export type TaskSdkMessageSubscriber = {
  send(message: SDKMessage): void;
};
