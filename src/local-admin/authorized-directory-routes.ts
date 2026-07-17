import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { TaskError } from "../tasks/errors.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { DirectorySelectionService } from "./directory-selection-service.js";
import { LocalAdminError } from "./errors.js";

const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const authorizedDirectorySchema = z.object({
  nonTerminalRuntimeCount: z.number().int().min(0),
  path: z.string().min(1).max(4_096),
  status: z.enum(["available", "unavailable"]),
  volumeRoot: z.boolean(),
});

export const authorizedDirectorySnapshotSchema = z.object({
  directories: z.array(authorizedDirectorySchema).max(1_024),
  revision: z.number().int().min(0),
});

const pickResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }),
  z.object({
    expiresAt: z.number().int(),
    path: z.string().min(1).max(4_096),
    selectionId: z.uuid(),
    status: z.literal("selected"),
    volumeRoot: z.boolean(),
  }),
]);

const addResponseSchema = z.object({
  coveringPath: z.string().min(1).max(4_096).optional(),
  removedRedundantPaths: z.array(z.string().min(1).max(4_096)),
  result: z.enum(["added", "already-covered"]),
  selectedPath: z.string().min(1).max(4_096),
  snapshot: authorizedDirectorySnapshotSchema,
});

const removeResponseSchema = z.object({
  removedPath: z.string().min(1).max(4_096),
  snapshot: authorizedDirectorySnapshotSchema,
  stoppedTaskCount: z.number().int().min(0),
});

const errorResponses = {
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema,
  503: errorResponseSchema,
} as const;

export type AuthorizedDirectoryManager = Pick<
  TaskManager,
  | "addAuthorizedDirectory"
  | "authorizedDirectorySnapshot"
  | "removeAuthorizedDirectory"
>;

export function registerAuthorizedDirectoryRoutes(
  app: FastifyInstance,
  options: {
    directorySelectionService: DirectorySelectionService;
    taskManager: AuthorizedDirectoryManager;
  },
): void {
  void app.register(async (scopedApp) => {
    scopedApp.setErrorHandler((error, _request, reply) => {
      if (error instanceof LocalAdminError || error instanceof TaskError) {
        return reply.code(error.statusCode).send({
          code: error.code,
          message: error.message,
        });
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "validation" in error
      ) {
        return reply.send(error);
      }
      return reply.code(500).send({
        code: "LOCAL_ADMIN_OPERATION_FAILED",
        message: "The local administration operation failed.",
      });
    });
    const typed = scopedApp.withTypeProvider<ZodTypeProvider>();

    typed.get(
      "/admin/authorized-directories",
      {
        schema: {
          response: {
            200: authorizedDirectorySnapshotSchema,
            ...errorResponses,
          },
        },
      },
      async () => options.taskManager.authorizedDirectorySnapshot(),
    );

    typed.post(
      "/admin/authorized-directories/pick",
      {
        schema: {
          response: { 200: pickResponseSchema, ...errorResponses },
        },
      },
      async (request) => {
        const abortController = new AbortController();
        const abort = (): void => abortController.abort();
        request.raw.once("aborted", abort);
        try {
          return await options.directorySelectionService.pick(
            abortController.signal,
          );
        } finally {
          request.raw.off("aborted", abort);
        }
      },
    );

    typed.post(
      "/admin/authorized-directories",
      {
        schema: {
          body: z
            .object({
              selectionId: z.uuid(),
              volumeRootRiskAccepted: z.boolean(),
            })
            .strict(),
          response: { 200: addResponseSchema, ...errorResponses },
        },
      },
      async (request) => {
        const selection = options.directorySelectionService.consume(
          request.body.selectionId,
        );
        return options.taskManager.addAuthorizedDirectory({
          selectedPath: selection.path,
          volumeRootRiskAccepted: request.body.volumeRootRiskAccepted,
        });
      },
    );

    typed.post(
      "/admin/authorized-directories/remove",
      {
        schema: {
          body: z
            .object({
              expectedNonTerminalRuntimeCount: z.number().int().min(0),
              path: z.string().min(1).max(4_096),
              revision: z.number().int().min(0),
              runtimeStopAccepted: z.boolean(),
            })
            .strict(),
          response: { 200: removeResponseSchema, ...errorResponses },
        },
      },
      async (request) =>
        options.taskManager.removeAuthorizedDirectory(request.body),
    );
  });
}
