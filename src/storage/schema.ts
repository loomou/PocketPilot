import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const agentSettings = sqliteTable("agent_settings", {
  key: text("key").primaryKey(),
  updatedAt: integer("updated_at").notNull(),
  valueJson: text("value_json").notNull(),
});

export const devices = sqliteTable(
  "devices",
  {
    createdAt: integer("created_at").notNull(),
    displayName: text("display_name").notNull(),
    id: text("id").primaryKey(),
    publicKey: text("public_key").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [index("devices_revoked_at_index").on(table.revokedAt)],
);

export const deviceCredentials = sqliteTable(
  "device_credentials",
  {
    createdAt: integer("created_at").notNull(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    lastUsedAt: integer("last_used_at").notNull(),
    secretEnvelope: text("secret_envelope").notNull(),
    supersededAt: integer("superseded_at"),
  },
  (table) => [
    index("device_credentials_device_id_index").on(table.deviceId),
    index("device_credentials_superseded_at_index").on(table.supersededAt),
  ],
);

export const pairings = sqliteTable(
  "pairings",
  {
    approvedAt: integer("approved_at"),
    createdAt: integer("created_at").notNull(),
    deviceId: text("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    expiresAt: integer("expires_at").notNull(),
    id: text("id").primaryKey(),
    secretEnvelope: text("secret_envelope").notNull(),
    usedAt: integer("used_at"),
  },
  (table) => [index("pairings_expires_at_index").on(table.expiresAt)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    createdAt: integer("created_at").notNull(),
    initialCwd: text("initial_cwd").notNull(),
    interruptedAt: integer("interrupted_at"),
    model: text("model"),
    permissionMode: text("permission_mode").notNull(),
    sdkSessionId: text("sdk_session_id"),
    state: text("state").notNull(),
    terminalAt: integer("terminal_at"),
    updatedAt: integer("updated_at").notNull(),
    id: text("id").primaryKey(),
  },
  (table) => [index("tasks_state_index").on(table.state)],
);

export const operationResults = sqliteTable(
  "operation_results",
  {
    createdAt: integer("created_at").notNull(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    operationId: text("operation_id").notNull(),
    resultJson: text("result_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.operationId] }),
    index("operation_results_expires_at_index").on(table.expiresAt),
  ],
);

export const auditRecords = sqliteTable(
  "audit_records",
  {
    deviceId: text("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    id: text("id").primaryKey(),
    occurredAt: integer("occurred_at").notNull(),
    operation: text("operation").notNull(),
    result: text("result").notNull(),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("audit_records_occurred_at_index").on(table.occurredAt)],
);

export const eventOverflow = sqliteTable(
  "event_overflow",
  {
    byteLength: integer("byte_length").notNull(),
    createdAt: integer("created_at").notNull(),
    cursor: integer("cursor").notNull(),
    payloadEnvelope: text("payload_envelope").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.cursor] })],
);

export const storageSchema = {
  agentSettings,
  auditRecords,
  deviceCredentials,
  devices,
  eventOverflow,
  operationResults,
  pairings,
  tasks,
};
