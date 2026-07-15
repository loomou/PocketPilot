import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeviceConnectionRegistry } from "../auth/device-auth-service.js";
import { readBearerAccessToken } from "../auth/http.js";
import type { TaskEventJournal } from "../tasks/task-event-journal.js";

const subscriptionSchema = z.object({
  afterCursor: z.number().int().min(-1).default(-1),
  taskId: z.uuid(),
  type: z.literal("subscribe"),
});

type TaskEventRouteOptions = {
  connectionRegistry: DeviceConnectionRegistry & {
    add(
      deviceId: string,
      socket: { close(code?: number, data?: string): void },
    ): () => void;
  };
  deviceAuthService: AccessDeviceAuthenticator;
  eventJournal: TaskEventJournal;
};

export type AccessDeviceAuthenticator = {
  authenticateAccessToken(accessToken: string): { id: string };
};

/** Registers the authenticated, task-scoped WebSocket replay endpoint. */
export function registerTaskEventRoutes(
  app: FastifyInstance,
  options: TaskEventRouteOptions,
): void {
  app.get("/v1/events", { websocket: true }, (socket, request) => {
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
        socket.send(
          JSON.stringify({
            code: "EVENT_SUBSCRIPTION_INVALID",
            type: "error",
          }),
        );
        return;
      }

      unsubscribeTask?.();
      unsubscribeTask = options.eventJournal.subscribe(
        subscription.taskId,
        subscription.afterCursor,
        {
          send(event): void {
            socket.send(JSON.stringify({ event, type: "event" }));
          },
        },
      );
      socket.send(
        JSON.stringify({
          afterCursor: subscription.afterCursor,
          taskId: subscription.taskId,
          type: "subscribed",
        }),
      );
    });
    socket.on("close", () => {
      unsubscribeTask?.();
      unregisterDevice();
    });
  });
}

function parseSubscription(
  message: unknown,
): z.infer<typeof subscriptionSchema> | undefined {
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
  const parsed = subscriptionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
