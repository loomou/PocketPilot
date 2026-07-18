import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { logEvents } from "../logging/events.js";
import { noopLogger, type PocketPilotLogger } from "../logging/logger.js";

export type CreateHttpAppOptions = {
  listenerKind?: "local-admin" | "remote";
  logger?: PocketPilotLogger;
  websocket?: boolean;
};

/** Creates an unbound Fastify instance with PocketPilot's HTTP contracts. */
export async function createHttpApp(
  options: CreateHttpAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const logger = (options.logger ?? noopLogger).child({
    listener: options.listenerKind ?? "unbound",
  });
  const requestStartTimes = new WeakMap<object, bigint>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onRequest", async (request) => {
    requestStartTimes.set(request, process.hrtime.bigint());
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartTimes.get(request);
    const durationMs =
      startedAt === undefined
        ? undefined
        : Math.round(Number(process.hrtime.bigint() - startedAt) / 100_000) /
          10;
    logger.debug(logEvents.httpRequestCompleted, "HTTP request completed", {
      ...(durationMs === undefined ? {} : { durationMs }),
      method: request.method,
      route: request.routeOptions.url,
      statusCode: reply.statusCode,
    });
  });

  if (options.websocket === true) {
    await app.register(websocket);
  }

  return app;
}
