import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentProviderError } from "../agent-providers/errors.js";
import { logEvents } from "../logging/events.js";
import {
  noopLogger,
  type PocketPilotLogger,
  type SafeLogFields,
  safeErrorFields,
} from "../logging/logger.js";
import { TaskError } from "../tasks/errors.js";
import { DeviceAuthError } from "./errors.js";

export const authErrorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const authErrorResponses = {
  401: authErrorResponseSchema,
  404: authErrorResponseSchema,
  409: authErrorResponseSchema,
  410: authErrorResponseSchema,
  422: authErrorResponseSchema,
} as const;

export function registerDeviceAuthErrorHandler(
  app: FastifyInstance,
  logger: PocketPilotLogger = noopLogger,
): void {
  app.setErrorHandler((error, request, reply) => {
    if (sendDeviceAuthOrTaskError(error, reply, { logger, request })) {
      return;
    }
    if (error instanceof AgentProviderError) {
      logger.warn(
        logEvents.httpRequestRejected,
        "Agent provider request rejected",
        {
          ...safeRequestFields(request),
          code: error.code,
          statusCode: error.statusCode,
        },
      );
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
    }
    logger.error(logEvents.httpRequestFailed, "HTTP request failed", {
      ...safeRequestFields(request),
      ...safeErrorFields(error),
      statusCode: 500,
    });
    return reply.send(error);
  });
}

/** Sends the stable HTTP response for errors shared by authenticated routes. */
export function sendDeviceAuthOrTaskError(
  error: unknown,
  reply: FastifyReply,
  context?: { logger: PocketPilotLogger; request: FastifyRequest },
): boolean {
  if (!(error instanceof DeviceAuthError) && !(error instanceof TaskError)) {
    return false;
  }
  if (context !== undefined) {
    context.logger.warn(
      error instanceof DeviceAuthError
        ? logEvents.authRequestRejected
        : logEvents.httpRequestRejected,
      error instanceof DeviceAuthError
        ? "Authentication request rejected"
        : "Task request rejected",
      {
        ...safeRequestFields(context.request),
        code: error.code,
        statusCode: error.statusCode,
      },
    );
  }
  void reply.code(error.statusCode).send({
    code: error.code,
    message: error.message,
  });
  return true;
}

export function readBearerAccessToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/.exec(authorization)
      : null;
  if (match?.[1] === undefined) {
    throw new DeviceAuthError(
      "ACCESS_TOKEN_INVALID",
      401,
      "A valid bearer access credential is required.",
    );
  }
  return match[1];
}

function safeRequestFields(request: FastifyRequest): SafeLogFields {
  const fields: Record<string, string> = {
    method: request.method,
    route: request.routeOptions.url ?? "unknown",
  };
  if (
    typeof request.params !== "object" ||
    request.params === null ||
    Array.isArray(request.params)
  ) {
    return fields;
  }
  for (const key of ["deviceId", "pairingId", "requestId", "taskId"] as const) {
    if (key in request.params) {
      const value = Reflect.get(request.params, key);
      if (typeof value === "string") {
        fields[key] = value;
      }
    }
  }
  return fields;
}
