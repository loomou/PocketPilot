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

const authenticationTag = ["Authentication"] as const;
const bearerSecurity = [{ bearerAuth: [] }] as const;

export type RemoteDeviceAuthRouteService = Pick<
  DeviceAuthService,
  | "authenticateAccessToken"
  | "claimPairingCredentials"
  | "createPairingClaimChallenge"
  | "createRefreshChallenge"
  | "refreshCredentials"
  | "registerPairingDevice"
>;

/** Registers remote pairing and device-authentication routes under /v1. */
export function registerRemoteDeviceAuthRoutes(
  app: FastifyInstance,
  deviceAuthService: RemoteDeviceAuthRouteService,
): void {
  registerDeviceAuthErrorHandler(app);
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/v1/pair/:pairingId/register",
    {
      schema: {
        body: registerPairingBodySchema,
        description:
          "Registers the scanning device key and returns the local verification code.",
        operationId: "registerPairingDevice",
        params: pairingIdParamsSchema,
        response: {
          200: pairingRegistrationResponseSchema,
          ...authErrorResponses,
        },
        summary: "Register a device for a pending pairing",
        tags: authenticationTag,
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
        description:
          "Creates a one-time proof challenge after the computer approves the pairing.",
        operationId: "createPairingClaimChallenge",
        params: pairingIdParamsSchema,
        response: {
          200: challengeResponseSchema,
          ...authErrorResponses,
        },
        summary: "Create a pairing claim challenge",
        tags: authenticationTag,
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
        description:
          "Verifies device-key possession and returns the first access and refresh credentials.",
        operationId: "claimPairingCredentials",
        params: pairingIdParamsSchema,
        response: {
          200: credentialResponseSchema,
          ...authErrorResponses,
        },
        summary: "Claim approved pairing credentials",
        tags: authenticationTag,
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
        description:
          "Creates a one-time challenge that the paired device signs before refresh rotation.",
        operationId: "createRefreshChallenge",
        params: z.object({ deviceId: deviceIdSchema }),
        response: {
          200: challengeResponseSchema,
          ...authErrorResponses,
        },
        summary: "Create a refresh proof challenge",
        tags: authenticationTag,
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
        description:
          "Rotates the bound refresh credential after validating the device signature.",
        operationId: "refreshCredentials",
        response: {
          200: credentialResponseSchema,
          ...authErrorResponses,
        },
        summary: "Rotate device credentials",
        tags: authenticationTag,
      },
    },
    async (request) => deviceAuthService.refreshCredentials(request.body),
  );

  typedApp.get(
    "/v1/auth/session",
    {
      schema: {
        description:
          "Returns metadata for the device bound to the supplied access credential.",
        operationId: "getAuthenticatedDeviceSession",
        response: {
          200: deviceResponseSchema,
          ...authErrorResponses,
        },
        security: bearerSecurity,
        summary: "Get the authenticated device session",
        tags: authenticationTag,
      },
    },
    async (request) =>
      deviceAuthService.authenticateAccessToken(readBearerAccessToken(request)),
  );
}
