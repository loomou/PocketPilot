import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
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

export function registerDeviceAuthErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DeviceAuthError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof TaskError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
    }
    return reply.send(error);
  });
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
