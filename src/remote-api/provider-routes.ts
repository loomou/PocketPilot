import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { AgentRuntimeManager } from "../agent-providers/runtime-manager.js";
import { agentProviderStatuses } from "../agent-providers/types.js";
import type { DeviceAuthService } from "../auth/device-auth-service.js";
import {
  authErrorResponseSchema,
  readBearerAccessToken,
} from "../auth/http.js";
import { taskOperationResultSchema } from "../tasks/task-types.js";

const bearerSecurity = [{ bearerAuth: [] }] as const;
const providerTag = ["Providers"] as const;
const conversationTag = ["Conversations"] as const;
const providerErrorResponses = {
  401: authErrorResponseSchema,
  403: authErrorResponseSchema,
  404: authErrorResponseSchema,
  409: authErrorResponseSchema,
  422: authErrorResponseSchema,
} as const;

const providerIdSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const providerParamsSchema = z.object({ providerId: providerIdSchema });
const conversationParamsSchema = providerParamsSchema.extend({
  conversationId: z.string().trim().min(1).max(512),
});
const workspaceSchema = z.string().trim().min(1).max(4_096);
const conversationListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  workspace: workspaceSchema,
});
const conversationHistoryQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(512).optional(),
  includeSystemMessages: z.enum(["true", "false"]).default("false"),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  workspace: workspaceSchema,
});
const conversationOperationSchema = z.object({
  operationId: z.uuid(),
  workspace: workspaceSchema,
  workspaceRiskAccepted: z.boolean(),
});

const agentNativeReviewActionSchema = z
  .object({
    availability: z.literal("idle"),
    deliveries: z.tuple([z.literal("inline")]).readonly(),
    method: z.string().min(1),
    startsTurn: z.literal(true),
    targetTypes: z
      .tuple([
        z.literal("uncommittedChanges"),
        z.literal("baseBranch"),
        z.literal("commit"),
        z.literal("custom"),
      ])
      .readonly(),
  })
  .strict();

const agentNativeRenameActionSchema = z
  .object({
    availability: z.literal("always"),
    method: z.string().min(1),
    startsTurn: z.literal(false),
  })
  .strict();

const agentNativeCompactActionSchema = z
  .object({
    availability: z.literal("idle"),
    method: z.string().min(1),
    startsTurn: z.literal(true),
  })
  .strict();

const agentNativeActionsSchema = z
  .object({
    compact: agentNativeCompactActionSchema.optional(),
    rename: agentNativeRenameActionSchema.optional(),
    review: agentNativeReviewActionSchema.optional(),
  })
  .strict();

const agentStatusCatalogsSchema = z
  .object({
    account: z.literal(true).optional(),
    hooks: z.literal(true).optional(),
    mcpServers: z.literal(true).optional(),
    rateLimits: z.literal(true).optional(),
    skills: z.literal(true).optional(),
  })
  .strict();

const capabilitySchema = z.object({
  activeTurnSteering: z.boolean(),
  approvals: z.boolean(),
  attachments: z.boolean(),
  effort: z.boolean(),
  historyPagination: z.enum(["cursor", "offset", "none"]),
  interrupt: z.boolean(),
  modes: z.boolean(),
  models: z.boolean(),
  nativeActions: agentNativeActionsSchema,
  newConversation: z.boolean(),
  resumeConversation: z.boolean(),
  statusCatalogs: agentStatusCatalogsSchema,
  streamProtocol: z.string(),
});

export const agentProviderDescriptorSchema = z.object({
  capabilities: capabilitySchema.optional(),
  displayName: z.string(),
  id: providerIdSchema,
  protocolVersion: z.string().optional(),
  reasonCode: z.string().optional(),
  status: z.enum(agentProviderStatuses),
});

const providerListResponseSchema = z.object({
  providers: z.array(agentProviderDescriptorSchema),
});
const providerCapabilitiesResponseSchema = agentProviderDescriptorSchema.pick({
  capabilities: true,
  id: true,
  protocolVersion: true,
  status: true,
});
const pageSchema = z.object({
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
});
const conversationListResponseSchema = z.object({
  conversations: z.array(z.unknown()),
  page: pageSchema,
});
const conversationHistoryResponseSchema = z.object({
  messages: z.array(z.unknown()),
  page: pageSchema,
});

export type ProviderRouteDeviceAuthService = Pick<
  DeviceAuthService,
  "authenticateAccessToken"
>;

export type ProviderRouteOptions = {
  agentRuntimeManager: Pick<
    AgentRuntimeManager,
    | "attachConversation"
    | "createConversation"
    | "listConversations"
    | "listProviders"
    | "providerCapabilities"
    | "readConversation"
  >;
  deviceAuthService: ProviderRouteDeviceAuthService;
};

/** Registers the authenticated, provider-extensible Agent catalog. */
export function registerProviderRoutes(
  app: FastifyInstance,
  options: ProviderRouteOptions,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = (request: FastifyRequest): string =>
    options.deviceAuthService.authenticateAccessToken(
      readBearerAccessToken(request),
    ).id;

  typed.get(
    "/v1/providers",
    {
      schema: {
        description:
          "Lists every registered local Agent provider, including unavailable providers. Status and reason codes are diagnostics-safe and read-only.",
        operationId: "listAgentProviders",
        response: {
          200: providerListResponseSchema,
          ...providerErrorResponses,
        },
        security: bearerSecurity,
        summary: "List Agent providers",
        tags: providerTag,
      },
    },
    (request) => {
      authenticate(request);
      return { providers: options.agentRuntimeManager.listProviders() };
    },
  );

  typed.get(
    "/v1/providers/:providerId/capabilities",
    {
      schema: {
        description:
          "Returns the selected provider status, native protocol version, and trustworthy capability snapshot when available.",
        operationId: "getAgentProviderCapabilities",
        params: providerParamsSchema,
        response: {
          200: providerCapabilitiesResponseSchema,
          ...providerErrorResponses,
        },
        security: bearerSecurity,
        summary: "Get Agent provider capabilities",
        tags: providerTag,
      },
    },
    (request) => {
      authenticate(request);
      return options.agentRuntimeManager.providerCapabilities(
        request.params.providerId,
      );
    },
  );

  typed.get(
    "/v1/providers/:providerId/conversations",
    {
      schema: {
        description:
          "Lists provider-native conversations in one authorized workspace. Native rows are preserved; page cursor metadata is owned by PocketPilot.",
        operationId: "listAgentConversations",
        params: providerParamsSchema,
        querystring: conversationListQuerySchema,
        response: {
          200: conversationListResponseSchema,
          ...providerErrorResponses,
        },
        security: bearerSecurity,
        summary: "List Agent conversations",
        tags: conversationTag,
      },
    },
    async (request) => {
      authenticate(request);
      const result = await options.agentRuntimeManager.listConversations(
        request.params.providerId,
        {
          ...(request.query.cursor === undefined
            ? {}
            : { cursor: request.query.cursor }),
          ...(request.query.limit === undefined
            ? {}
            : { limit: request.query.limit }),
          workspace: request.query.workspace,
        },
      );
      return { conversations: result.items, page: result.page };
    },
  );

  typed.get(
    "/v1/providers/:providerId/conversations/:conversationId",
    {
      schema: {
        description:
          "Reads one page of provider-native conversation history from the selected authorized workspace.",
        operationId: "readAgentConversation",
        params: conversationParamsSchema,
        querystring: conversationHistoryQuerySchema,
        response: {
          200: conversationHistoryResponseSchema,
          ...providerErrorResponses,
        },
        security: bearerSecurity,
        summary: "Read Agent conversation history",
        tags: conversationTag,
      },
    },
    async (request) => {
      authenticate(request);
      const result = await options.agentRuntimeManager.readConversation(
        request.params.providerId,
        {
          ...(request.query.cursor === undefined
            ? {}
            : { cursor: request.query.cursor }),
          includeSystemMessages: request.query.includeSystemMessages === "true",
          ...(request.query.limit === undefined
            ? {}
            : { limit: request.query.limit }),
          nativeConversationId: request.params.conversationId,
          workspace: request.query.workspace,
        },
      );
      return { messages: result.items, page: result.page };
    },
  );

  typed.post(
    "/v1/providers/:providerId/conversations",
    {
      schema: {
        body: conversationOperationSchema,
        description:
          "Creates an empty provider-native conversation runtime in an authorized workspace and returns its PocketPilot task transport metadata.",
        operationId: "createAgentConversation",
        params: providerParamsSchema,
        response: { 200: taskOperationResultSchema, ...providerErrorResponses },
        security: bearerSecurity,
        summary: "Create an Agent conversation",
        tags: conversationTag,
      },
    },
    (request) =>
      options.agentRuntimeManager.createConversation(
        request.params.providerId,
        { ...request.body, deviceId: authenticate(request) },
      ),
  );

  typed.post(
    "/v1/providers/:providerId/conversations/:conversationId/attach",
    {
      schema: {
        body: conversationOperationSchema,
        description:
          "Attaches or reuses the provider runtime for a selected native conversation and returns PocketPilot task transport metadata.",
        operationId: "attachAgentConversation",
        params: conversationParamsSchema,
        response: { 200: taskOperationResultSchema, ...providerErrorResponses },
        security: bearerSecurity,
        summary: "Attach an Agent conversation",
        tags: conversationTag,
      },
    },
    (request) =>
      options.agentRuntimeManager.attachConversation(
        request.params.providerId,
        {
          ...request.body,
          deviceId: authenticate(request),
          nativeConversationId: request.params.conversationId,
        },
      ),
  );
}
