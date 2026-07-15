import { z } from "zod";

export const taskEventEnvelopeSchema = z.object({
  cursor: z.number().int().nonnegative(),
  event: z.object({
    kind: z.string().min(1),
    payload: z.unknown(),
  }),
  occurredAt: z.number().int(),
  taskId: z.uuid(),
});

export type TaskEvent = z.infer<typeof taskEventEnvelopeSchema>["event"];
export type TaskEventEnvelope = z.infer<typeof taskEventEnvelopeSchema>;

export type TaskEventSink = {
  beginTurn(taskId: string): void;
  endTurn(taskId: string): void;
  publish(taskId: string, event: TaskEvent): TaskEventEnvelope;
};

export type TaskEventSubscriber = {
  send(event: TaskEventEnvelope): void;
};
