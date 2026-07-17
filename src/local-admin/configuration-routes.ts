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
import {
  readTaskRuntimeSettings,
  taskCapacitySettingsSchema,
  writeTaskCapacitySettings,
} from "../tasks/settings.js";

const auditRecordSchema = z.object({
  deviceId: z.string().uuid().nullable(),
  id: z.string().uuid(),
  occurredAt: z.number().int(),
  operation: z.string(),
  result: z.string(),
  taskId: z.string().uuid().nullable(),
});

export function registerConfigurationRoutes(
  app: FastifyInstance,
  options: {
    settingsRepository: SettingsRepository;
    sqlite: BetterSqlite3.Database;
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
            tasks: taskCapacitySettingsSchema,
          }),
        },
      },
    },
    async () => ({
      runtime: readRuntimeSettings(options.settingsRepository),
      tasks: taskCapacitySettingsSchema.parse(
        readTaskRuntimeSettings(options.settingsRepository),
      ),
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
        body: taskCapacitySettingsSchema,
        response: { 200: taskCapacitySettingsSchema },
      },
    },
    async (request) => {
      return writeTaskCapacitySettings(
        options.settingsRepository,
        request.body,
      );
    },
  );
  typed.get(
    "/admin/audits",
    { schema: { response: { 200: z.array(auditRecordSchema) } } },
    async () =>
      options.sqlite
        .prepare<[], z.infer<typeof auditRecordSchema>>(
          "SELECT device_id AS deviceId, id, occurred_at AS occurredAt, operation, result, task_id AS taskId FROM audit_records ORDER BY occurred_at DESC",
        )
        .all(),
  );
}
