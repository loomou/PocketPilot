import { eq } from "drizzle-orm";
import type { ZodType } from "zod";
import type { StorageDatabase } from "./database.js";
import { StorageDataError } from "./errors.js";
import { agentSettings } from "./schema.js";

/**
 * Typed owner for non-secret Agent settings stored as JSON.
 *
 * Individual feature modules supply a Zod schema, so corrupted SQLite data
 * cannot become an unchecked configuration object at a later boundary.
 */
export class SettingsRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public get<T>(key: string, schema: ZodType<T>): T | undefined {
    const row = this.database
      .select({ valueJson: agentSettings.valueJson })
      .from(agentSettings)
      .where(eq(agentSettings.key, key))
      .get();

    if (row === undefined) {
      return undefined;
    }

    return parseSettingValue(key, row.valueJson, schema);
  }

  public set<T>(
    key: string,
    value: T,
    schema: ZodType<T>,
    updatedAt = Date.now(),
  ): void {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new StorageDataError(`Setting '${key}' does not match its schema.`);
    }

    const valueJson = JSON.stringify(parsed.data);
    this.database
      .insert(agentSettings)
      .values({ key, updatedAt, valueJson })
      .onConflictDoUpdate({
        target: agentSettings.key,
        set: { updatedAt, valueJson },
      })
      .run();
  }
}

function parseSettingValue<T>(
  key: string,
  valueJson: string,
  schema: ZodType<T>,
): T {
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    throw new StorageDataError(`Setting '${key}' contains invalid JSON.`);
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new StorageDataError(`Setting '${key}' does not match its schema.`);
  }

  return parsed.data;
}
