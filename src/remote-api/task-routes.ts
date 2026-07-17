import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { DeviceAuthService } from "../auth/device-auth-service.js";
import {
  authErrorResponseSchema,
  readBearerAccessToken,
} from "../auth/http.js";
import type { TaskManager } from "../tasks/task-manager.js";
import {
  taskOperationResultSchema,
  taskSnapshotSchema,
} from "../tasks/task-types.js";

const operationSchema = z.object({ operationId: z.uuid() });
const taskIdParamsSchema = z.object({ taskId: z.uuid() });
const createTaskSchema = operationSchema.extend({
  initialCwd: z.string().min(1),
  model: z.string().min(1).optional(),
  permissionMode: z.string().min(1),
  workspaceRiskAccepted: z.boolean(),
});

export const permissionResultSchema = z.discriminatedUnion("behavior", [
  z
    .object({
      behavior: z.literal("allow"),
      decisionClassification: z
        .enum(["user_temporary", "user_permanent", "user_reject"])
        .optional(),
      toolUseID: z.string().optional(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(z.unknown()).optional(),
    })
    .passthrough(),
  z
    .object({
      behavior: z.literal("deny"),
      decisionClassification: z
        .enum(["user_temporary", "user_permanent", "user_reject"])
        .optional(),
      interrupt: z.boolean().optional(),
      message: z.string(),
      toolUseID: z.string().optional(),
    })
    .passthrough(),
]);

const bearerSecurity = [{ bearerAuth: [] }] as const;
const taskTag = ["Tasks"] as const;
const taskErrorResponses = {
  401: authErrorResponseSchema,
  403: authErrorResponseSchema,
  404: authErrorResponseSchema,
  409: authErrorResponseSchema,
  422: authErrorResponseSchema,
} as const;

export type TaskRouteDeviceAuthService = Pick<
  DeviceAuthService,
  "authenticateAccessToken"
>;

export type TaskRouteManager = Pick<
  TaskManager,
  | "closeTask"
  | "createTask"
  | "getTask"
  | "interruptTask"
  | "listTasks"
  | "resolveApproval"
  | "resumeTask"
  | "setModel"
  | "setPermissionMode"
  | "supportedPermissionModes"
>;

export function registerTaskRoutes(
  app: FastifyInstance,
  options: {
    deviceAuthService: TaskRouteDeviceAuthService;
    taskManager: TaskRouteManager;
  },
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = (request: FastifyRequest): string =>
    options.deviceAuthService.authenticateAccessToken(
      readBearerAccessToken(request),
    ).id;

  typed.get(
    "/v1/capabilities",
    {
      schema: {
        description:
          "Returns protocol metadata and permission modes supported by the installed SDK.",
        operationId: "getCapabilities",
        response: {
          200: z.object({
            protocolVersion: z.literal(1),
            supportedPermissionModes: z.array(z.string()),
          }),
          ...taskErrorResponses,
        },
        security: bearerSecurity,
        summary: "Get Agent capabilities",
        tags: taskTag,
      },
    },
    async (request) => {
      authenticate(request);
      return {
        protocolVersion: 1 as const,
        supportedPermissionModes: [
          ...options.taskManager.supportedPermissionModes(),
        ],
      };
    },
  );
  typed.get(
    "/v1/tasks",
    {
      schema: {
        description:
          "Lists persistent task-session metadata without transcripts.",
        operationId: "listTasks",
        response: {
          200: z.array(taskSnapshotSchema),
          ...taskErrorResponses,
        },
        security: bearerSecurity,
        summary: "List task sessions",
        tags: taskTag,
      },
    },
    async (request) => {
      authenticate(request);
      return options.taskManager.listTasks();
    },
  );
  typed.get(
    "/v1/tasks/:taskId",
    {
      schema: {
        description: "Returns metadata for one persistent task session.",
        operationId: "getTask",
        params: taskIdParamsSchema,
        response: { 200: taskSnapshotSchema, ...taskErrorResponses },
        security: bearerSecurity,
        summary: "Get a task session",
        tags: taskTag,
      },
    },
    async (request) => {
      authenticate(request);
      return options.taskManager.getTask(request.params.taskId);
    },
  );
  typed.post(
    "/v1/tasks",
    {
      schema: {
        body: createTaskSchema,
        description:
          "Creates an idle Claude task after workspace authorization and explicit scope-risk acceptance.",
        operationId: "createTask",
        response: { 200: taskOperationResultSchema, ...taskErrorResponses },
        security: bearerSecurity,
        summary: "Create a task session",
        tags: taskTag,
      },
    },
    async (request) =>
      options.taskManager.createTask({
        ...request.body,
        deviceId: authenticate(request),
      }),
  );
  typed.post(
    "/v1/tasks/:taskId/interrupt",
    {
      schema: {
        body: operationSchema,
        description:
          "Interrupts the current turn or pending approval while retaining the task session.",
        operationId: "interruptTask",
        params: taskIdParamsSchema,
        response: { 200: taskOperationResultSchema, ...taskErrorResponses },
        security: bearerSecurity,
        summary: "Interrupt the current task turn",
        tags: taskTag,
      },
    },
    async (request) =>
      options.taskManager.interruptTask({
        ...request.body,
        deviceId: authenticate(request),
        taskId: request.params.taskId,
      }),
  );
  typed.post(
    "/v1/tasks/:taskId/close",
    {
      schema: {
        body: operationSchema,
        description:
          "Immediately cancels current work and makes the task terminal and non-resumable.",
        operationId: "closeTask",
        params: taskIdParamsSchema,
        response: { 200: taskOperationResultSchema, ...taskErrorResponses },
        security: bearerSecurity,
        summary: "Close a task session",
        tags: taskTag,
      },
    },
    async (request) =>
      options.taskManager.closeTask({
        ...request.body,
        deviceId: authenticate(request),
        taskId: request.params.taskId,
      }),
  );
  typed.post(
    "/v1/tasks/:taskId/resume",
    {
      schema: {
        body: operationSchema,
        description:
          "Reconnects an interrupted task to its saved SDK session without replaying work.",
        operationId: "resumeTask",
        params: taskIdParamsSchema,
        response: { 200: taskOperationResultSchema, ...taskErrorResponses },
        security: bearerSecurity,
        summary: "Resume an interrupted task",
        tags: taskTag,
      },
    },
    async (request) =>
      options.taskManager.resumeTask({
        ...request.body,
        deviceId: authenticate(request),
        taskId: request.params.taskId,
      }),
  );
  typed.post(
    "/v1/tasks/:taskId/model",
    {
      schema: {
        body: operationSchema.extend({ model: z.string().min(1).optional() }),
        description:
          "Changes the model for the next turn while the task is idle.",
        operationId: "setTaskModel",
        params: taskIdParamsSchema,
        response: { 200: taskOperationResultSchema, ...taskErrorResponses },
        security: bearerSecurity,
        summary: "Change a task model",
        tags: taskTag,
      },
    },
    async (request) =>
      options.taskManager.setModel({
        deviceId: authenticate(request),
        model: request.body.model,
        operationId: request.body.operationId,
        taskId: request.params.taskId,
      }),
  );
  typed.post(
    "/v1/tasks/:taskId/permission-mode",
    {
      schema: {
        body: operationSchema.extend({ permissionMode: z.string().min(1) }),
        description:
          "Forwards a supported permission mode to the installed Claude Agent SDK.",
        operationId: "setTaskPermissionMode",
        params: taskIdParamsSchema,
        response: { 200: taskOperationResultSchema, ...taskErrorResponses },
        security: bearerSecurity,
        summary: "Change a task permission mode",
        tags: taskTag,
      },
    },
    async (request) =>
      options.taskManager.setPermissionMode({
        ...request.body,
        deviceId: authenticate(request),
        taskId: request.params.taskId,
      }),
  );
  typed.post(
    "/v1/tasks/:taskId/approvals/:requestId",
    {
      schema: {
        body: operationSchema.extend({ result: permissionResultSchema }),
        description:
          "Returns the complete Claude Agent SDK PermissionResult for the pending request.",
        operationId: "resolveTaskApproval",
        params: taskIdParamsSchema.extend({ requestId: z.string().min(1) }),
        response: { 200: taskOperationResultSchema, ...taskErrorResponses },
        security: bearerSecurity,
        summary: "Resolve a task approval",
        tags: taskTag,
      },
    },
    async (request) =>
      options.taskManager.resolveApproval({
        deviceId: authenticate(request),
        operationId: request.body.operationId,
        requestId: request.params.requestId,
        result: request.body.result as PermissionResult,
        taskId: request.params.taskId,
      }),
  );
}
