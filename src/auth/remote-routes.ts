import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { DeviceAuthService } from "./device-auth-service.js";
import {
  authErrorResponses,
  readBearerAccessToken,
  registerDeviceAuthErrorHandler,
} from "./http.js";

const pairingIdParamsSchema = z.object({
  pairingId: z.uuid(),
});

const deviceIdSchema = z.uuid();

const registerPairingBodySchema = z.object({
  deviceDisplayName: z.string().trim().min(1).max(128),
  devicePublicKey: z.string().min(1).max(256),
});

const proofBodySchema = z.object({
  challengeId: z.uuid(),
  signature: z.string().min(1).max(256),
});

const refreshBodySchema = proofBodySchema.extend({
  refreshToken: z.string().min(1).max(512),
});

const pairingRegistrationResponseSchema = z.object({
  expiresAt: z.number().int(),
  pairingId: z.uuid(),
  verificationCode: z.string().regex(/^\d{6}$/),
});

const challengeResponseSchema = z.object({
  challengeId: z.uuid(),
  expiresAt: z.number().int(),
  message: z.string().min(1),
  nonce: z.string().min(1),
});

const credentialResponseSchema = z.object({
  accessExpiresAt: z.number().int(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

const deviceResponseSchema = z.object({
  createdAt: z.number().int(),
  displayName: z.string(),
  id: z.uuid(),
  revokedAt: z.number().int().nullable(),
});

/** Registers remote pairing and device-authentication routes under /v1. */
export function registerRemoteDeviceAuthRoutes(
  app: FastifyInstance,
  deviceAuthService: DeviceAuthService,
): void {
  registerDeviceAuthErrorHandler(app);
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/v1/pair/:pairingId/register",
    {
      schema: {
        body: registerPairingBodySchema,
        params: pairingIdParamsSchema,
        response: {
          200: pairingRegistrationResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) =>
      deviceAuthService.registerPairingDevice({
        ...request.body,
        pairingId: request.params.pairingId,
      }),
  );

  typedApp.post(
    "/v1/pair/:pairingId/claim-challenge",
    {
      schema: {
        params: pairingIdParamsSchema,
        response: {
          200: challengeResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) =>
      deviceAuthService.createPairingClaimChallenge(request.params.pairingId),
  );

  typedApp.post(
    "/v1/pair/:pairingId/claim",
    {
      schema: {
        body: proofBodySchema,
        params: pairingIdParamsSchema,
        response: {
          200: credentialResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) =>
      deviceAuthService.claimPairingCredentials({
        ...request.body,
        pairingId: request.params.pairingId,
      }),
  );

  typedApp.post(
    "/v1/auth/refresh-challenge/:deviceId",
    {
      schema: {
        params: z.object({ deviceId: deviceIdSchema }),
        response: {
          200: challengeResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) =>
      deviceAuthService.createRefreshChallenge(request.params.deviceId),
  );

  typedApp.post(
    "/v1/auth/refresh",
    {
      schema: {
        body: refreshBodySchema,
        response: {
          200: credentialResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => deviceAuthService.refreshCredentials(request.body),
  );

  typedApp.get(
    "/v1/auth/session",
    {
      schema: {
        response: {
          200: deviceResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) =>
      deviceAuthService.authenticateAccessToken(readBearerAccessToken(request)),
  );
}
