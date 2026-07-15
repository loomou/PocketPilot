import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { DeviceAuthService } from "../auth/device-auth-service.js";
import { registerLocalDeviceAuthRoutes } from "../auth/local-admin-routes.js";
import { createHttpApp } from "../http/create-http-app.js";
import { registerHealthRoute } from "../http/health.js";
import {
  hasValidLocalAdminCsrfToken,
  isUnsafeHttpMethod,
  type LocalAdminCsrfProtection,
} from "./csrf.js";

const localAdminListenerSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
});

const localAdminStatusSchema = z.object({
  localAdminListener: localAdminListenerSchema,
  mobileBaseUrl: z.url().optional(),
  remoteListener: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
  }),
  status: z.literal("running"),
});

const csrfResponseSchema = z.object({
  token: z.string().min(1),
});

const shutdownResponseSchema = z.object({
  status: z.literal("stopping"),
});

const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type LocalAdminStatus = z.infer<typeof localAdminStatusSchema>;

export type LocalAdminAppOptions = {
  csrfProtection: LocalAdminCsrfProtection;
  deviceAuthService?: DeviceAuthService;
  getStatus(): LocalAdminStatus;
  requestShutdown(): void;
  shutdownControlToken: string;
};

/**
 * Builds the loopback-only local administration listener without binding it.
 * Binding to 127.0.0.1 is owned exclusively by the runtime layer.
 */
export async function buildLocalAdminApp(
  options: LocalAdminAppOptions,
): Promise<FastifyInstance> {
  const app = await createHttpApp();
  registerHealthRoute(app);

  app.addHook("onRequest", async (request, reply) => {
    if (
      !isUnsafeHttpMethod(request.method) ||
      request.url.startsWith("/_internal/")
    ) {
      return;
    }

    if (!hasValidLocalAdminCsrfToken(request, options.csrfProtection)) {
      return reply.code(403).send({
        code: "LOCAL_ADMIN_CSRF_REJECTED",
        message:
          "This local administration request was rejected by CSRF protection.",
      });
    }
  });

  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  typedApp.get(
    "/admin/status",
    {
      schema: {
        response: {
          200: localAdminStatusSchema,
        },
      },
    },
    async () => options.getStatus(),
  );

  typedApp.get(
    "/admin/csrf",
    {
      schema: {
        response: {
          200: csrfResponseSchema,
        },
      },
    },
    async () => ({ token: options.csrfProtection.token }),
  );

  typedApp.post(
    "/_internal/shutdown",
    {
      schema: {
        response: {
          202: shutdownResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        request.headers["x-pocketpilot-control-token"] !==
        options.shutdownControlToken
      ) {
        return reply.code(401).send({
          code: "RUNTIME_CONTROL_UNAUTHORIZED",
          message: "The local runtime control credential is invalid.",
        });
      }

      options.requestShutdown();
      return reply.code(202).send({ status: "stopping" as const });
    },
  );

  if (options.deviceAuthService !== undefined) {
    registerLocalDeviceAuthRoutes(app, options.deviceAuthService);
  }

  return app;
}
