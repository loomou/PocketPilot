import type BetterSqlite3 from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  readRuntimeSettings,
  runtimeSettingsSchema,
  writeRuntimeSettings,
} from "../runtime/settings.js";
import type { SettingsRepository } from "../storage/settings-repository.js";
import { taskRuntimeSettingsSchema } from "../tasks/settings.js";
import type { WorkspaceAuthorizationCoordinator } from "../tasks/workspace-authorization-coordinator.js";
import type { DirectoryBrowserService } from "./directory-browser-service.js";

const taskRuntimeSettingsUpdateSchema = taskRuntimeSettingsSchema.extend({
  confirmedHighRiskRoots: z
    .array(z.string().trim().min(1).max(4_096))
    .max(1_024)
    .default([]),
});

const auditRecordSchema = z.object({
  deviceId: z.string().uuid().nullable(),
  id: z.string().uuid(),
  occurredAt: z.number().int(),
  operation: z.string(),
  result: z.string(),
  taskId: z.string().uuid().nullable(),
  toolName: z.string().nullable(),
});

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const auditQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .catch(50)
    .transform((value) => clamp(value, 1, 200)),
  offset: z.coerce
    .number()
    .int()
    .catch(0)
    .transform((value) => Math.max(0, value)),
  q: z.string().trim().max(256).catch("").optional(),
  result: z.string().trim().max(256).catch("").optional(),
});

const auditPageSchema = z.object({
  items: z.array(auditRecordSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

const auditSelectColumns =
  "device_id AS deviceId, id, occurred_at AS occurredAt, operation, result, task_id AS taskId, tool_name AS toolName";

/**
 * Escapes LIKE wildcards so a user-supplied search term only matches those
 * characters literally. The backslash is used as the ESCAPE character.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function registerConfigurationRoutes(
  app: FastifyInstance,
  options: {
    settingsRepository: SettingsRepository;
    sqlite: BetterSqlite3.Database;
    directoryBrowserService: DirectoryBrowserService;
    workspaceAuthorizationCoordinator: WorkspaceAuthorizationCoordinator;
  },
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/admin/configuration",
    {
      schema: {
        response: {
          200: z.object({
            runtime: runtimeSettingsSchema,
            tasks: taskRuntimeSettingsSchema,
          }),
        },
      },
    },
    async () => ({
      runtime: readRuntimeSettings(options.settingsRepository),
      tasks:
        options.workspaceAuthorizationCoordinator.readTaskRuntimeSettings(),
    }),
  );
  typed.put(
    "/admin/configuration/runtime",
    {
      schema: {
        body: runtimeSettingsSchema,
        response: { 200: runtimeSettingsSchema },
      },
    },
    async (request) => {
      writeRuntimeSettings(options.settingsRepository, request.body);
      return request.body;
    },
  );
  typed.put(
    "/admin/configuration/tasks",
    {
      schema: {
        body: taskRuntimeSettingsUpdateSchema,
        response: { 200: taskRuntimeSettingsSchema },
      },
    },
    async (request) => {
      return options.workspaceAuthorizationCoordinator.replaceTaskRuntimeSettings(
        request.body,
      );
    },
  );
  typed.post(
    "/admin/directories/browse",
    {
      schema: {
        body: z.object({
          path: z.string().trim().min(1).max(4_096).optional(),
        }),
        response: {
          200: z.object({
            currentPath: z.string().nullable(),
            parentPath: z.string().nullable(),
            entries: z.array(
              z.object({
                name: z.string(),
                path: z.string(),
                accessible: z.boolean(),
                root: z.boolean(),
              }),
            ),
            truncated: z.boolean(),
          }),
        },
      },
    },
    async (request) =>
      options.directoryBrowserService.browse(request.body.path),
  );
  typed.post(
    "/admin/directories/inspect",
    {
      schema: {
        body: z.object({
          paths: z.array(z.string().trim().min(1).max(4_096)).min(1).max(1_024),
        }),
        response: {
          200: z.array(
            z.object({
              configuredPath: z.string(),
              status: z.enum(["available", "unavailable"]),
              canonicalPath: z.string().optional(),
              highRisk: z.boolean(),
              coveredBy: z.string().optional(),
            }),
          ),
        },
      },
    },
    async (request) =>
      options.workspaceAuthorizationCoordinator.inspectWorkspaceRoots(
        request.body.paths,
      ),
  );

  typed.get(
    "/admin/audits",
    {
      schema: {
        querystring: auditQuerySchema,
        response: { 200: auditPageSchema },
      },
    },
    async (request) => {
      const { limit, offset, q, result } = request.query;
      const conditions: string[] = [];
      const filterParameters: Array<number | string> = [];

      const trimmedQuery = q?.trim();
      if (trimmedQuery !== undefined && trimmedQuery !== "") {
        const pattern = `%${escapeLikeTerm(trimmedQuery.toLowerCase())}%`;
        conditions.push(
          "(LOWER(operation) LIKE ? ESCAPE '\\' OR LOWER(result) LIKE ? ESCAPE '\\' OR LOWER(tool_name) LIKE ? ESCAPE '\\' OR LOWER(device_id) LIKE ? ESCAPE '\\' OR LOWER(task_id) LIKE ? ESCAPE '\\')",
        );
        filterParameters.push(pattern, pattern, pattern, pattern, pattern);
      }

      const trimmedResult = result?.trim();
      if (trimmedResult !== undefined && trimmedResult !== "") {
        conditions.push("result = ?");
        filterParameters.push(trimmedResult);
      }

      const whereClause =
        conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;

      const total = (
        options.sqlite
          .prepare<Array<number | string>, { total: number }>(
            `SELECT COUNT(*) AS total FROM audit_records${whereClause}`,
          )
          .get(...filterParameters) ?? { total: 0 }
      ).total;

      const items = options.sqlite
        .prepare<Array<number | string>, z.infer<typeof auditRecordSchema>>(
          `SELECT ${auditSelectColumns} FROM audit_records${whereClause} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...filterParameters, limit, offset);

      return { items, limit, offset, total };
    },
  );
}
