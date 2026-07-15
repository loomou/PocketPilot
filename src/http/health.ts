import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

/** Registers the intentionally minimal, non-sensitive health contract. */
export function registerHealthRoute(app: FastifyInstance): void {
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
}
