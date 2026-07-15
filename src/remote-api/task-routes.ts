import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { DeviceAuthService } from "../auth/device-auth-service.js";
import { readBearerAccessToken } from "../auth/http.js";
import type { TaskManager } from "../tasks/task-manager.js";

const operationSchema = z.object({ operationId: z.uuid() });
const taskIdParamsSchema = z.object({ taskId: z.uuid() });
const taskResponseSchema = z.object({
  createdAt: z.number().int(),
  id: z.uuid(),
  initialCwd: z.string(),
  interruptedAt: z.number().int().nullable(),
  model: z.string().nullable(),
  permissionMode: z.string(),
  sdkSessionId: z.string().nullable(),
  state: z.string(),
  terminalAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});
const resultResponseSchema = z.object({
  action: z.string(),
  task: taskResponseSchema,
});
const createTaskSchema = operationSchema.extend({
  initialCwd: z.string().min(1),
  model: z.string().min(1).optional(),
  permissionMode: z.string().min(1),
  workspaceRiskAccepted: z.boolean(),
});

export function registerTaskRoutes(
  app: FastifyInstance,
  options: { deviceAuthService: DeviceAuthService; taskManager: TaskManager },
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
        response: {
          200: z.object({
            protocolVersion: z.literal(1),
            supportedPermissionModes: z.array(z.string()),
          }),
        },
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
    { schema: { response: { 200: z.array(taskResponseSchema) } } },
    async (request) => {
      authenticate(request);
      return options.taskManager.listTasks();
    },
  );
  typed.get(
    "/v1/tasks/:taskId",
    {
      schema: {
        params: taskIdParamsSchema,
        response: { 200: taskResponseSchema },
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
        response: { 200: resultResponseSchema },
      },
    },
    async (request) =>
      options.taskManager.createTask({
        ...request.body,
        deviceId: authenticate(request),
      }),
  );
  typed.post(
    "/v1/tasks/:taskId/instruction",
    {
      schema: {
        body: operationSchema.extend({ instruction: z.string().min(1) }),
        params: taskIdParamsSchema,
        response: { 200: resultResponseSchema },
      },
    },
    async (request) =>
      options.taskManager.submitInstruction({
        ...request.body,
        deviceId: authenticate(request),
        taskId: request.params.taskId,
      }),
  );
  typed.post(
    "/v1/tasks/:taskId/interrupt",
    {
      schema: {
        body: operationSchema,
        params: taskIdParamsSchema,
        response: { 200: resultResponseSchema },
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
        params: taskIdParamsSchema,
        response: { 200: resultResponseSchema },
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
        params: taskIdParamsSchema,
        response: { 200: resultResponseSchema },
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
        params: taskIdParamsSchema,
        response: { 200: resultResponseSchema },
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
        params: taskIdParamsSchema,
        response: { 200: resultResponseSchema },
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
    "/v1/tasks/:taskId/approvals/:approvalId",
    {
      schema: {
        body: operationSchema.extend({ decision: z.enum(["approve", "deny"]) }),
        params: taskIdParamsSchema.extend({ approvalId: z.string().min(1) }),
        response: { 200: resultResponseSchema },
      },
    },
    async (request) =>
      options.taskManager.resolveApproval({
        ...request.body,
        approvalId: request.params.approvalId,
        deviceId: authenticate(request),
        taskId: request.params.taskId,
      }),
  );
}
