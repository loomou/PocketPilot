import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { PocketPilotLogger } from "../logging/logger.js";

import type { DeviceAuthService } from "./device-auth-service.js";
import { authErrorResponses, registerDeviceAuthErrorHandler } from "./http.js";

const pairingIdParamsSchema = z.object({
  pairingId: z.uuid(),
});

const deviceIdParamsSchema = z.object({
  deviceId: z.uuid(),
});

const createdPairingResponseSchema = z.object({
  expiresAt: z.number().int(),
  pairingId: z.uuid(),
  qrPayload: z.object({
    agentId: z.uuid(),
    baseUrl: z.url(),
    expiresAt: z.number().int(),
    pairingId: z.uuid(),
    version: z.literal(1),
  }),
});

const pendingPairingsResponseSchema = z.array(
  z.object({
    deviceDisplayName: z.string(),
    expiresAt: z.number().int(),
    pairingId: z.uuid(),
    verificationCode: z.string().regex(/^\d{6}$/),
  }),
);

const deviceResponseSchema = z.object({
  createdAt: z.number().int(),
  displayName: z.string(),
  id: z.uuid(),
  revokedAt: z.number().int().nullable(),
});

const revocationResponseSchema = z.object({
  revoked: z.boolean(),
});

/** Registers loopback-only pairing approval and device-revocation operations. */
export function registerLocalDeviceAuthRoutes(
  app: FastifyInstance,
  deviceAuthService: DeviceAuthService,
  logger?: PocketPilotLogger,
  installErrorHandler = true,
): void {
  if (installErrorHandler) {
    registerDeviceAuthErrorHandler(app, logger);
  }
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/admin/pairings",
    {
      schema: {
        response: {
          201: createdPairingResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (_request, reply) =>
      reply.code(201).send(deviceAuthService.createPairing()),
  );

  typedApp.get(
    "/admin/pairings/pending",
    {
      schema: {
        response: {
          200: pendingPairingsResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async () => deviceAuthService.listPendingPairings(),
  );

  typedApp.post(
    "/admin/pairings/:pairingId/approve",
    {
      schema: {
        body: z.object({
          verificationCode: z.string().regex(/^\d{6}$/),
        }),
        params: pairingIdParamsSchema,
        response: {
          200: deviceResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) =>
      deviceAuthService.approvePairing({
        pairingId: request.params.pairingId,
        verificationCode: request.body.verificationCode,
      }),
  );

  typedApp.get(
    "/admin/devices",
    {
      schema: {
        response: {
          200: z.array(deviceResponseSchema),
          ...authErrorResponses,
        },
      },
    },
    async () => deviceAuthService.listDevices(),
  );

  typedApp.post(
    "/admin/devices/:deviceId/revoke",
    {
      schema: {
        params: deviceIdParamsSchema,
        response: {
          200: revocationResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => ({
      revoked: deviceAuthService.revokeDevice(request.params.deviceId),
    }),
  );
}
