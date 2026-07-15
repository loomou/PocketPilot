import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";

const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

/**
 * Creates the HTTP application without binding a network listener.
 *
 * The secure remote and localhost-only listeners are added in a later task.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(websocket);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/healthz",
    {
      schema: {
        response: {
          200: healthResponseSchema,
        },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  return app;
}
