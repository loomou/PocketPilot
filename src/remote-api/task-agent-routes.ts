import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { AgentRuntimeManager } from "../agent-providers/runtime-manager.js";
import type { DeviceConnectionRegistry } from "../auth/device-auth-service.js";
import { readBearerAccessToken } from "../auth/http.js";
import { logEvents } from "../logging/events.js";
import { noopLogger, type PocketPilotLogger } from "../logging/logger.js";
import { TaskError } from "../tasks/errors.js";
import type { AccessDeviceAuthenticator } from "./task-event-routes.js";

export const agentWebSocketClose = {
  authenticationFailed: { code: 4_003, reason: "AUTHENTICATION_FAILED" },
  messageInvalid: { code: 4_000, reason: "SDK_MESSAGE_INVALID" },
  sessionUnavailable: { code: 4_009, reason: "TASK_SESSION_UNAVAILABLE" },
  taskNotFound: { code: 4_004, reason: "TASK_NOT_FOUND" },
  transportFailed: { code: 4_011, reason: "SDK_TRANSPORT_FAILED" },
} as const;

const taskAgentParamsSchema = z.object({ taskId: z.uuid() });
const taskAgentQuerySchema = z.object({
  afterCursor: z.string().min(1).max(512).optional(),
});

export const taskAgentRouteDocumentation = {
  description:
    "Authenticated bidirectional transport for the selected task provider's native client and server messages. Frames have no PocketPilot payload wrapper.",
  operationId: "streamTaskAgentMessages",
  security: [{ bearerAuth: [] }],
  summary: "Exchange provider-native Agent messages",
  tags: ["Agent Stream"],
};

type TaskAgentWebSocket = {
  close(code?: number, data?: string): void;
};

export type TaskAgentRouteOptions = {
  agentRuntimeManager: Pick<AgentRuntimeManager, "task" | "taskProvider">;
  connectionRegistry: DeviceConnectionRegistry & {
    add(deviceId: string, socket: TaskAgentWebSocket): () => void;
  };
  deviceAuthService: AccessDeviceAuthenticator;
  logger?: PocketPilotLogger;
  taskConnectionRegistry: {
    add(taskId: string, socket: TaskAgentWebSocket): () => void;
  };
};

/** Registers the provider-native task WebSocket without normalizing frames. */
export function registerTaskAgentRoutes(
  app: FastifyInstance,
  options: TaskAgentRouteOptions,
): void {
  const logger = options.logger ?? noopLogger;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/v1/tasks/:taskId/agent",
    {
      schema: {
        ...taskAgentRouteDocumentation,
        params: taskAgentParamsSchema,
        querystring: taskAgentQuerySchema,
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
          "Agent WebSocket authentication rejected",
          { code: "AUTHENTICATION_FAILED", transport: "agent" },
        );
        closeSocket(socket, agentWebSocketClose.authenticationFailed);
        return;
      }

      const taskId = request.params.taskId;
      let provider: ReturnType<AgentRuntimeManager["taskProvider"]>;
      let providerId: string;
      try {
        const task = options.agentRuntimeManager.task(taskId);
        providerId = task.provider;
        if (task.state === "interrupted" || task.state === "terminal") {
          closeSocket(socket, agentWebSocketClose.sessionUnavailable);
          return;
        }
        provider = options.agentRuntimeManager.taskProvider(taskId);
      } catch (error) {
        const failure =
          error instanceof TaskError && error.code === "TASK_NOT_FOUND"
            ? agentWebSocketClose.taskNotFound
            : agentWebSocketClose.transportFailed;
        logger.warn(
          logEvents.websocketAgentClosed,
          "Agent WebSocket rejected",
          {
            closeCode: failure.code,
            code: failure.reason,
            deviceId,
            taskId,
          },
        );
        closeSocket(socket, failure);
        return;
      }

      let closed = false;
      const unregisterDevice = options.connectionRegistry.add(deviceId, socket);
      const unregisterTask = options.taskConnectionRegistry.add(taskId, socket);
      logger.info(
        logEvents.websocketAgentConnected,
        "Agent WebSocket connected",
        {
          deviceId,
          provider: providerId,
          taskId,
        },
      );
      let unsubscribe = (): void => {};
      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        unsubscribe();
        unregisterTask();
        unregisterDevice();
      };
      const terminate = (failure: WebSocketFailure): void => {
        logger.warn(
          logEvents.websocketAgentClosed,
          "Agent WebSocket terminated",
          {
            closeCode: failure.code,
            code: failure.reason,
            deviceId,
            provider: providerId,
            taskId,
          },
        );
        cleanup();
        closeSocket(socket, failure);
      };

      try {
        unsubscribe = provider.taskStream.subscribe(
          taskId,
          request.query.afterCursor,
          {
            send(message): void {
              if (closed) {
                return;
              }
              try {
                socket.send(JSON.stringify(message));
              } catch {
                terminate(agentWebSocketClose.transportFailed);
              }
            },
          },
        );
      } catch {
        terminate(agentWebSocketClose.transportFailed);
        return;
      }

      if (closed) {
        unsubscribe();
        return;
      }

      void provider.taskStream.activate(taskId).catch((error) => {
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
          const message = provider.taskStream.parseClientFrame(frame, isBinary);
          if (message === undefined) {
            terminate(agentWebSocketClose.messageInvalid);
            return;
          }
          void provider.taskStream
            .submit({ deviceId, message, taskId })
            .catch((error: unknown) => {
              if (!closed) {
                terminate(taskSubmissionFailure(error));
              }
            });
        },
      );
      socket.on("close", () => {
        if (!closed) {
          logger.info(
            logEvents.websocketAgentClosed,
            "Agent WebSocket closed",
            {
              deviceId,
              provider: providerId,
              taskId,
            },
          );
        }
        cleanup();
      });
      socket.on("error", () => {
        if (!closed) {
          logger.warn(
            logEvents.websocketAgentClosed,
            "Agent WebSocket transport failed",
            {
              closeCode: agentWebSocketClose.transportFailed.code,
              code: agentWebSocketClose.transportFailed.reason,
              deviceId,
              provider: providerId,
              taskId,
            },
          );
        }
        cleanup();
      });
    },
  );
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

function taskSubmissionFailure(error: unknown): WebSocketFailure {
  if (!(error instanceof TaskError)) {
    return agentWebSocketClose.transportFailed;
  }
  if (error.code === "TASK_NOT_FOUND") {
    return agentWebSocketClose.taskNotFound;
  }
  return agentWebSocketClose.sessionUnavailable;
}
