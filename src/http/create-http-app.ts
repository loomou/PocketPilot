import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

export type CreateHttpAppOptions = {
  websocket?: boolean;
};

/** Creates an unbound Fastify instance with PocketPilot's HTTP contracts. */
export async function createHttpApp(
  options: CreateHttpAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  if (options.websocket === true) {
    await app.register(websocket);
  }

  return app;
}
