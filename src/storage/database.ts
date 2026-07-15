import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { storageSchema } from "./schema.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packagedMigrationsFolder = resolve(sourceDirectory, "drizzle");
const defaultMigrationsFolder = existsSync(
  resolve(packagedMigrationsFolder, "meta/_journal.json"),
)
  ? packagedMigrationsFolder
  : resolve(sourceDirectory, "../../drizzle");

export type StorageDatabase = BetterSQLite3Database<typeof storageSchema>;

export type StorageConnection = {
  close(): void;
  database: StorageDatabase;
  sqlite: BetterSqlite3.Database;
};

export type OpenStorageOptions = {
  databasePath: string;
  migrationsFolder?: string;
};

export function openStorage(options: OpenStorageOptions): StorageConnection {
  if (options.databasePath !== ":memory:") {
    mkdirSync(dirname(options.databasePath), { recursive: true });
  }

  const sqlite = new BetterSqlite3(options.databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");

  const database = drizzle(sqlite, { schema: storageSchema });
  migrate(database, {
    migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder,
  });

  return {
    close(): void {
      sqlite.close();
    },
    database,
    sqlite,
  };
}
