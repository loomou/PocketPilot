import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { DeviceAuthService } from "../auth/device-auth-service.js";
import {
  authErrorResponseSchema,
  readBearerAccessToken,
} from "../auth/http.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { taskOperationResultSchema } from "../tasks/task-types.js";

const bearerSecurity = [{ bearerAuth: [] }] as const;
const sessionTag = ["Sessions"] as const;
const sessionErrorResponses = {
  401: authErrorResponseSchema,
  403: authErrorResponseSchema,
  404: authErrorResponseSchema,
  409: authErrorResponseSchema,
  422: authErrorResponseSchema,
} as const;

const workspaceSchema = z.string().trim().min(1).max(4_096);
const sessionIdParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(256),
});
const sessionOperationSchema = z.object({
  operationId: z.uuid(),
  workspace: workspaceSchema,
  workspaceRiskAccepted: z.boolean(),
});
const sessionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  workspace: workspaceSchema,
});
const sessionHistoryQuerySchema = z.object({
  beforeUuid: z.string().trim().min(1).max(256).optional(),
  includeSystemMessages: z.enum(["true", "false"]).default("false"),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  workspace: workspaceSchema,
});

export const sdkSessionInfoSchema = z
  .object({
    createdAt: z.number().optional(),
    customTitle: z.string().optional(),
    cwd: z.string().optional(),
    fileSize: z.number().optional(),
    firstPrompt: z.string().optional(),
    gitBranch: z.string().optional(),
    lastModified: z.number(),
    sessionId: z.string(),
    summary: z.string(),
    tag: z.string().optional(),
  })
  .passthrough()
  .describe(
    "SDKSessionInfo owned by @anthropic-ai/claude-agent-sdk@0.3.210. Unknown SDK fields are preserved.",
  );

export const sdkSessionMessageSchema = z
  .object({
    message: z.unknown(),
    parent_agent_id: z.string().nullable(),
    parent_tool_use_id: z.string().nullable(),
    session_id: z.string(),
    type: z.enum(["user", "assistant", "system"]),
    uuid: z.string(),
  })
  .passthrough()
  .describe(
    "SessionMessage owned by @anthropic-ai/claude-agent-sdk@0.3.210. PocketPilot does not normalize transcript rows.",
  );

const sessionListResponseSchema = z.object({
  nextOffset: z.number().int().nullable(),
  sessions: z.array(sdkSessionInfoSchema),
});
const sessionHistoryResponseSchema = z.object({
  messages: z.array(sdkSessionMessageSchema),
  page: z.object({
    beforeUuid: z.string().nullable(),
    hasMoreBefore: z.boolean(),
  }),
});

export type SessionRouteDeviceAuthService = Pick<
  DeviceAuthService,
  "authenticateAccessToken"
>;

export type SessionRouteManager = Pick<
  TaskManager,
  | "attachClaudeSession"
  | "createClaudeConversation"
  | "listClaudeSessions"
  | "readClaudeSessionHistory"
>;

/** Registers the authenticated, workspace-scoped Claude session surface. */
export function registerSessionRoutes(
  app: FastifyInstance,
  options: {
    deviceAuthService: SessionRouteDeviceAuthService;
    taskManager: SessionRouteManager;
  },
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = (request: FastifyRequest): string =>
    options.deviceAuthService.authenticateAccessToken(
      readBearerAccessToken(request),
    ).id;

  typed.get(
    "/v1/sessions",
    {
      schema: {
        description:
          "Lists installed-SDK sessions for one authorized workspace. Worktree discovery is disabled and programmatic sessions are included. SDK rows remain unchanged; continue while nextOffset is non-null even if a filtered page is empty.",
        operationId: "listClaudeSessions",
        querystring: sessionListQuerySchema,
        response: { 200: sessionListResponseSchema, ...sessionErrorResponses },
        security: bearerSecurity,
        summary: "List Claude sessions",
        tags: sessionTag,
      },
    },
    async (request) => {
      authenticate(request);
      return options.taskManager.listClaudeSessions({
        workspace: request.query.workspace,
        ...(request.query.limit === undefined
          ? {}
          : { limit: request.query.limit }),
        ...(request.query.offset === undefined
          ? {}
          : { offset: request.query.offset }),
      });
    },
  );

  typed.get(
    "/v1/sessions/:sessionId/messages",
    {
      schema: {
        description:
          "Returns an unchanged chronological SDK SessionMessage page. The latest page and each older page contain at most 50 rows. Pass the prior page.beforeUuid to prepend older rows and keep includeSystemMessages unchanged throughout that cursor sequence. HISTORY_CURSOR_STALE means reload the latest page. The SDK currently reparses the local transcript for every page; history failure does not stop an attached Query.",
        operationId: "readClaudeSessionHistory",
        params: sessionIdParamsSchema,
        querystring: sessionHistoryQuerySchema,
        response: {
          200: sessionHistoryResponseSchema,
          ...sessionErrorResponses,
        },
        security: bearerSecurity,
        summary: "Read Claude session history",
        tags: sessionTag,
      },
    },
    async (request) => {
      authenticate(request);
      return options.taskManager.readClaudeSessionHistory({
        includeSystemMessages: request.query.includeSystemMessages === "true",
        sessionId: request.params.sessionId,
        workspace: request.query.workspace,
        ...(request.query.beforeUuid === undefined
          ? {}
          : { beforeUuid: request.query.beforeUuid }),
        ...(request.query.limit === undefined
          ? {}
          : { limit: request.query.limit }),
      });
    },
  );

  typed.post(
    "/v1/sessions",
    {
      schema: {
        body: sessionOperationSchema,
        description:
          "Starts an empty-history conversation runtime in an authorized workspace. Claude Code resolves model, permission and effort defaults; the returned task ID is only an opaque transport handle.",
        operationId: "createClaudeConversation",
        response: { 200: taskOperationResultSchema, ...sessionErrorResponses },
        security: bearerSecurity,
        summary: "Start a new Claude conversation",
        tags: sessionTag,
      },
    },
    async (request) =>
      options.taskManager.createClaudeConversation({
        ...request.body,
        deviceId: authenticate(request),
      }),
  );

  typed.post(
    "/v1/sessions/:sessionId/attach",
    {
      schema: {
        body: sessionOperationSchema,
        description:
          "Transparently attaches or reuses the one non-terminal runtime for a selected SDK session. Selection itself is continuation; no separate task-resume action is required.",
        operationId: "attachClaudeSession",
        params: sessionIdParamsSchema,
        response: { 200: taskOperationResultSchema, ...sessionErrorResponses },
        security: bearerSecurity,
        summary: "Attach a Claude session",
        tags: sessionTag,
      },
    },
    async (request) =>
      options.taskManager.attachClaudeSession({
        ...request.body,
        deviceId: authenticate(request),
        sessionId: request.params.sessionId,
      }),
  );
}
