import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { DeviceConnectionRegistry } from "../auth/device-auth-service.js";
import { readBearerAccessToken } from "../auth/http.js";
import { TaskError } from "../tasks/errors.js";
import type { TaskEventJournal } from "../tasks/task-event-journal.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { AccessDeviceAuthenticator } from "./task-event-routes.js";

export const sdkWebSocketClose = {
  authenticationFailed: { code: 4_003, reason: "AUTHENTICATION_FAILED" },
  messageInvalid: { code: 4_000, reason: "SDK_MESSAGE_INVALID" },
  sessionUnavailable: { code: 4_009, reason: "TASK_SESSION_UNAVAILABLE" },
  taskNotFound: { code: 4_004, reason: "TASK_NOT_FOUND" },
  transportFailed: { code: 4_011, reason: "SDK_TRANSPORT_FAILED" },
} as const;

const taskSdkParamsSchema = z.object({ taskId: z.uuid() });
const taskSdkQuerySchema = z.object({
  afterUuid: z.string().min(1).max(256).optional(),
});

export const sdkUserMessageTransportSchema = z
  .object({
    isSynthetic: z.boolean().optional(),
    message: z
      .object({
        content: z.union([z.string(), z.array(z.unknown())]),
        role: z.literal("user"),
      })
      .passthrough(),
    origin: z.object({}).passthrough().optional(),
    parent_tool_use_id: z.string().nullable(),
    priority: z.enum(["now", "next", "later"]).optional(),
    session_id: z.string().optional(),
    shouldQuery: z.boolean().optional(),
    timestamp: z.string().optional(),
    type: z.literal("user"),
    uuid: z.string().optional(),
  })
  .passthrough()
  .describe(
    "Raw SDKUserMessage transport base. The installed SDK owns optional and future fields.",
  );

export const taskSdkRouteDocumentation = {
  description:
    "Authenticated bidirectional transport for raw @anthropic-ai/claude-agent-sdk SDKUserMessage and SDKMessage objects.",
  operationId: "streamTaskSdkMessages",
  security: [{ bearerAuth: [] }],
  summary: "Exchange raw Claude SDK messages",
  tags: ["SDK"],
};

export type TaskSdkRouteOptions = {
  connectionRegistry: DeviceConnectionRegistry & {
    add(
      deviceId: string,
      socket: { close(code?: number, data?: string): void },
    ): () => void;
  };
  deviceAuthService: AccessDeviceAuthenticator;
  eventJournal: Pick<TaskEventJournal, "subscribeSdk">;
  taskManager: Pick<
    TaskManager,
    "activateSdkSession" | "getTask" | "submitSdkMessage"
  >;
};

/** Registers the raw, task-specific Claude SDK WebSocket transport. */
export function registerTaskSdkRoutes(
  app: FastifyInstance,
  options: TaskSdkRouteOptions,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/v1/tasks/:taskId/sdk",
    {
      schema: {
        ...taskSdkRouteDocumentation,
        params: taskSdkParamsSchema,
        querystring: taskSdkQuerySchema,
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
        closeSocket(socket, sdkWebSocketClose.authenticationFailed);
        return;
      }

      const taskId = request.params.taskId;
      try {
        const task = options.taskManager.getTask(taskId);
        if (task.state === "interrupted" || task.state === "terminal") {
          closeSocket(socket, sdkWebSocketClose.sessionUnavailable);
          return;
        }
      } catch (error) {
        closeSocket(
          socket,
          error instanceof TaskError && error.code === "TASK_NOT_FOUND"
            ? sdkWebSocketClose.taskNotFound
            : sdkWebSocketClose.transportFailed,
        );
        return;
      }

      let closed = false;
      const unregisterDevice = options.connectionRegistry.add(deviceId, socket);
      let unsubscribeSdk = (): void => {};
      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        unsubscribeSdk();
        unregisterDevice();
      };
      const terminate = (failure: WebSocketFailure): void => {
        cleanup();
        closeSocket(socket, failure);
      };
      let subscribedUnsubscribe: () => void;
      try {
        subscribedUnsubscribe = options.eventJournal.subscribeSdk(
          taskId,
          request.query.afterUuid,
          {
            send(message): void {
              if (closed) {
                return;
              }
              try {
                socket.send(JSON.stringify(message));
              } catch {
                terminate(sdkWebSocketClose.transportFailed);
              }
            },
          },
        );
      } catch {
        terminate(sdkWebSocketClose.transportFailed);
        return;
      }
      unsubscribeSdk = subscribedUnsubscribe;
      if (closed) {
        unsubscribeSdk();
        return;
      }

      void options.taskManager.activateSdkSession(taskId).catch((error) => {
        if (!closed) {
          terminate(taskSubmissionFailure(error));
        }
      });

      socket.on(
        "message",
        (frame: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          if (closed) {
            return;
          }
          const message = parseSdkUserMessageFrame(frame, isBinary);
          if (message === undefined) {
            terminate(sdkWebSocketClose.messageInvalid);
            return;
          }

          void options.taskManager
            .submitSdkMessage({ deviceId, message, taskId })
            .catch((error: unknown) => {
              if (closed) {
                return;
              }
              terminate(taskSubmissionFailure(error));
            });
        },
      );
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    },
  );
}

export function parseSdkUserMessageFrame(
  frame: unknown,
  isBinary = false,
): SDKUserMessage | undefined {
  if (isBinary) {
    return undefined;
  }
  const text = decodeSocketMessage(frame);
  if (text === undefined) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!sdkUserMessageTransportSchema.safeParse(value).success) {
    return undefined;
  }
  return value as SDKUserMessage;
}

type WebSocketFailure = {
  code: number;
  reason: string;
};

function closeSocket(
  socket: { close(code?: number, data?: string): void },
  failure: WebSocketFailure,
): void {
  socket.close(failure.code, failure.reason);
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

function taskSubmissionFailure(error: unknown): WebSocketFailure {
  if (!(error instanceof TaskError)) {
    return sdkWebSocketClose.transportFailed;
  }
  if (error.code === "TASK_NOT_FOUND") {
    return sdkWebSocketClose.taskNotFound;
  }
  return sdkWebSocketClose.sessionUnavailable;
}
