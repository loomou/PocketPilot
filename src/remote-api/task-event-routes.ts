import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeviceConnectionRegistry } from "../auth/device-auth-service.js";
import { readBearerAccessToken } from "../auth/http.js";
import { logEvents } from "../logging/events.js";
import { noopLogger, type PocketPilotLogger } from "../logging/logger.js";
import type { TaskEventJournal } from "../tasks/task-event-journal.js";
import { taskControlEventEnvelopeSchema } from "../tasks/task-events.js";

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
  event: taskControlEventEnvelopeSchema,
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
    "Authenticated WebSocket subscription for PocketPilot task/control events only. Claude SDK messages use the task-specific SDK WebSocket.",
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
  eventJournal: Pick<TaskEventJournal, "subscribeControl">;
  logger?: PocketPilotLogger;
};

export type AccessDeviceAuthenticator = {
  authenticateAccessToken(accessToken: string): { id: string };
};

/** Registers the authenticated, task-scoped WebSocket replay endpoint. */
export function registerTaskEventRoutes(
  app: FastifyInstance,
  options: TaskEventRouteOptions,
): void {
  const logger = options.logger ?? noopLogger;
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
        logger.warn(
          logEvents.authRequestRejected,
          "Control WebSocket authentication rejected",
          { code: "AUTHENTICATION_FAILED", transport: "control" },
        );
        socket.close(4003, "Authentication failed.");
        return;
      }

      const unregisterDevice = options.connectionRegistry.add(deviceId, socket);
      logger.info(
        logEvents.websocketControlConnected,
        "Control WebSocket connected",
        { deviceId },
      );
      let closed = false;
      let subscribedTaskId: string | undefined;
      let unsubscribeTask: (() => void) | undefined;
      socket.on("message", (message: Buffer | ArrayBuffer | Buffer[]) => {
        const subscription = parseSubscription(message);
        if (subscription === undefined) {
          logger.warn(
            logEvents.websocketMessageRejected,
            "Control WebSocket message rejected",
            { code: "EVENT_SUBSCRIPTION_INVALID", deviceId },
          );
          sendServerMessage(socket, {
            code: "EVENT_SUBSCRIPTION_INVALID",
            type: "error",
          });
          return;
        }

        unsubscribeTask?.();
        subscribedTaskId = subscription.taskId;
        unsubscribeTask = options.eventJournal.subscribeControl(
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
        logger.info(
          logEvents.websocketControlConnected,
          "Control WebSocket subscribed",
          { deviceId, taskId: subscription.taskId },
        );
      });
      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        unsubscribeTask?.();
        unregisterDevice();
        logger.info(
          logEvents.websocketControlClosed,
          "Control WebSocket closed",
          {
            deviceId,
            ...(subscribedTaskId === undefined
              ? {}
              : { taskId: subscribedTaskId }),
          },
        );
      };
      socket.on("close", cleanup);
      socket.on("error", () => {
        logger.warn(
          logEvents.websocketControlClosed,
          "Control WebSocket transport failed",
          {
            code: "CONTROL_TRANSPORT_FAILED",
            deviceId,
            ...(subscribedTaskId === undefined
              ? {}
              : { taskId: subscribedTaskId }),
          },
        );
        cleanup();
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
