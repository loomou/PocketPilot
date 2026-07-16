import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeviceConnectionRegistry } from "../auth/device-auth-service.js";
import { readBearerAccessToken } from "../auth/http.js";
import type { TaskEventJournal } from "../tasks/task-event-journal.js";
import { taskEventEnvelopeSchema } from "../tasks/task-events.js";

export const eventSubscriptionMessageSchema = z.object({
  afterCursor: z.number().int().min(-1).default(-1),
  taskId: z.uuid(),
  type: z.literal("subscribe"),
});

export const eventSubscribedMessageSchema = z.object({
  afterCursor: z.number().int().min(-1),
  taskId: z.uuid(),
  type: z.literal("subscribed"),
});

export const eventDeliveryMessageSchema = z.object({
  event: taskEventEnvelopeSchema,
  type: z.literal("event"),
});

export const eventErrorMessageSchema = z.object({
  code: z.literal("EVENT_SUBSCRIPTION_INVALID"),
  type: z.literal("error"),
});

const eventServerMessageSchema = z.discriminatedUnion("type", [
  eventSubscribedMessageSchema,
  eventDeliveryMessageSchema,
  eventErrorMessageSchema,
]);

export const taskEventRouteDocumentation = {
  description:
    "Authenticated WebSocket subscription for active-turn replay and live task events. See x-websocket in the generated OpenAPI document.",
  operationId: "subscribeTaskEvents",
  security: [{ bearerAuth: [] }],
  summary: "Subscribe to task events",
  tags: ["Events"],
};

export type TaskEventRouteOptions = {
  connectionRegistry: DeviceConnectionRegistry & {
    add(
      deviceId: string,
      socket: { close(code?: number, data?: string): void },
    ): () => void;
  };
  deviceAuthService: AccessDeviceAuthenticator;
  eventJournal: Pick<TaskEventJournal, "subscribe">;
};

export type AccessDeviceAuthenticator = {
  authenticateAccessToken(accessToken: string): { id: string };
};

/** Registers the authenticated, task-scoped WebSocket replay endpoint. */
export function registerTaskEventRoutes(
  app: FastifyInstance,
  options: TaskEventRouteOptions,
): void {
  app.get(
    "/v1/events",
    {
      schema: {
        ...taskEventRouteDocumentation,
      },
      websocket: true,
    },
    (socket, request) => {
      let deviceId: string;
      try {
        deviceId = options.deviceAuthService.authenticateAccessToken(
          readBearerAccessToken(request),
        ).id;
      } catch {
        socket.close(4003, "Authentication failed.");
        return;
      }

      const unregisterDevice = options.connectionRegistry.add(deviceId, socket);
      let unsubscribeTask: (() => void) | undefined;
      socket.on("message", (message: Buffer | ArrayBuffer | Buffer[]) => {
        const subscription = parseSubscription(message);
        if (subscription === undefined) {
          sendServerMessage(socket, {
            code: "EVENT_SUBSCRIPTION_INVALID",
            type: "error",
          });
          return;
        }

        unsubscribeTask?.();
        unsubscribeTask = options.eventJournal.subscribe(
          subscription.taskId,
          subscription.afterCursor,
          {
            send(event): void {
              sendServerMessage(socket, { event, type: "event" });
            },
          },
        );
        sendServerMessage(socket, {
          afterCursor: subscription.afterCursor,
          taskId: subscription.taskId,
          type: "subscribed",
        });
      });
      socket.on("close", () => {
        unsubscribeTask?.();
        unregisterDevice();
      });
    },
  );
}

function parseSubscription(
  message: unknown,
): z.infer<typeof eventSubscriptionMessageSchema> | undefined {
  const text = decodeSocketMessage(message);
  if (text === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = eventSubscriptionMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function sendServerMessage(
  socket: { send(message: string): void },
  message: z.input<typeof eventServerMessageSchema>,
): void {
  socket.send(JSON.stringify(eventServerMessageSchema.parse(message)));
}

function decodeSocketMessage(message: unknown): string | undefined {
  if (typeof message === "string") {
    return message;
  }
  if (Buffer.isBuffer(message)) {
    return message.toString("utf8");
  }
  if (message instanceof ArrayBuffer) {
    return Buffer.from(message).toString("utf8");
  }
  if (Array.isArray(message) && message.every(Buffer.isBuffer)) {
    return Buffer.concat(message).toString("utf8");
  }
  return undefined;
}
