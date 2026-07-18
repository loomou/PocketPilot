import { z } from "zod";

const listenerSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
});

const runtimeSettingsSchema = z.object({
  mobileBaseUrl: z.url().optional(),
  remoteListener: listenerSchema,
});

const taskSettingsSchema = z.object({
  concurrentTaskCapacity: z.number().int().min(1).max(1_024),
});

const authorizedDirectorySchema = z.object({
  nonTerminalRuntimeCount: z.number().int().min(0),
  path: z.string().min(1).max(4_096),
  status: z.enum(["available", "unavailable"]),
  volumeRoot: z.boolean(),
});

const authorizedDirectorySnapshotSchema = z.object({
  directories: z.array(authorizedDirectorySchema).max(1_024),
  revision: z.number().int().min(0),
});

const directoryPickResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }),
  z.object({
    expiresAt: z.number().int(),
    path: z.string().min(1).max(4_096),
    selectionId: z.uuid(),
    status: z.literal("selected"),
    volumeRoot: z.boolean(),
  }),
]);

const addAuthorizedDirectoryResponseSchema = z.object({
  coveringPath: z.string().min(1).max(4_096).optional(),
  removedRedundantPaths: z.array(z.string().min(1).max(4_096)),
  result: z.enum(["added", "already-covered"]),
  selectedPath: z.string().min(1).max(4_096),
  snapshot: authorizedDirectorySnapshotSchema,
});

const removeAuthorizedDirectoryResponseSchema = z.object({
  removedPath: z.string().min(1).max(4_096),
  snapshot: authorizedDirectorySnapshotSchema,
  stoppedTaskCount: z.number().int().min(0),
});

const configurationSchema = z.object({
  runtime: runtimeSettingsSchema,
  tasks: taskSettingsSchema,
});

const csrfSchema = z.object({ token: z.string().min(1) });

const agentStatusSchema = z.object({
  localAdminListener: listenerSchema,
  mobileBaseUrl: z.url().optional(),
  remoteListener: listenerSchema,
  status: z.literal("running"),
});

const qrPayloadSchema = z.object({
  agentId: z.uuid(),
  baseUrl: z.url(),
  expiresAt: z.number().int(),
  pairingId: z.uuid(),
  version: z.literal(1),
});

const createdPairingSchema = z.object({
  expiresAt: z.number().int(),
  pairingId: z.uuid(),
  qrPayload: qrPayloadSchema,
});

const deviceSchema = z.object({
  createdAt: z.number().int(),
  displayName: z.string().min(1),
  id: z.uuid(),
  revokedAt: z.number().int().nullable(),
});

const auditRecordSchema = z.object({
  deviceId: z.string().uuid().nullable(),
  id: z.string().uuid(),
  occurredAt: z.number().int(),
  operation: z.string().min(1),
  result: z.string().min(1),
  taskId: z.string().uuid().nullable(),
});

const errorResponseSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

const revokedResponseSchema = z.object({ revoked: z.boolean() });

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AuthorizedDirectory = z.infer<typeof authorizedDirectorySchema>;
export type AuthorizedDirectorySnapshot = z.infer<
  typeof authorizedDirectorySnapshotSchema
>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
export type CreatedPairing = z.infer<typeof createdPairingSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export type TaskSettings = z.infer<typeof taskSettingsSchema>;

export type LocalAdminSnapshot = {
  audits: AuditRecord[];
  authorizedDirectories: AuthorizedDirectorySnapshot;
  configuration: Configuration;
  csrfToken: string;
  devices: Device[];
  status: AgentStatus;
};

export class LocalAdminApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalAdminApiError";
  }
}

export async function loadLocalAdminSnapshot(): Promise<LocalAdminSnapshot> {
  const [csrf, configuration, status, devices, audits, authorizedDirectories] =
    await Promise.all([
      getJson("/admin/csrf", csrfSchema),
      getJson("/admin/configuration", configurationSchema),
      getJson("/admin/status", agentStatusSchema),
      getJson("/admin/devices", z.array(deviceSchema)),
      getJson("/admin/audits", z.array(auditRecordSchema)),
      getJson(
        "/admin/authorized-directories",
        authorizedDirectorySnapshotSchema,
      ),
    ]);

  return {
    audits,
    authorizedDirectories,
    configuration,
    csrfToken: csrf.token,
    devices,
    status,
  };
}

export function loadAuthorizedDirectories(): Promise<AuthorizedDirectorySnapshot> {
  return getJson(
    "/admin/authorized-directories",
    authorizedDirectorySnapshotSchema,
  );
}

export function pickAuthorizedDirectory(
  csrfToken: string,
): Promise<z.infer<typeof directoryPickResponseSchema>> {
  return mutateJson(
    "/admin/authorized-directories/pick",
    "POST",
    csrfToken,
    undefined,
    directoryPickResponseSchema,
  );
}

export function addAuthorizedDirectory(
  csrfToken: string,
  selectionId: string,
  volumeRootRiskAccepted: boolean,
): Promise<z.infer<typeof addAuthorizedDirectoryResponseSchema>> {
  return mutateJson(
    "/admin/authorized-directories",
    "POST",
    csrfToken,
    { selectionId, volumeRootRiskAccepted },
    addAuthorizedDirectoryResponseSchema,
  );
}

export function removeAuthorizedDirectory(
  csrfToken: string,
  input: {
    expectedNonTerminalRuntimeCount: number;
    path: string;
    revision: number;
    runtimeStopAccepted: true;
  },
): Promise<z.infer<typeof removeAuthorizedDirectoryResponseSchema>> {
  return mutateJson(
    "/admin/authorized-directories/remove",
    "POST",
    csrfToken,
    input,
    removeAuthorizedDirectoryResponseSchema,
  );
}

export function saveRuntimeSettings(
  csrfToken: string,
  settings: RuntimeSettings,
): Promise<RuntimeSettings> {
  return mutateJson(
    "/admin/configuration/runtime",
    "PUT",
    csrfToken,
    settings,
    runtimeSettingsSchema,
  );
}

export function saveTaskSettings(
  csrfToken: string,
  settings: TaskSettings,
): Promise<TaskSettings> {
  return mutateJson(
    "/admin/configuration/tasks",
    "PUT",
    csrfToken,
    settings,
    taskSettingsSchema,
  );
}

export function createPairing(csrfToken: string): Promise<CreatedPairing> {
  return mutateJson(
    "/admin/pairings",
    "POST",
    csrfToken,
    undefined,
    createdPairingSchema,
  );
}

export function approvePairing(
  csrfToken: string,
  pairingId: string,
  verificationCode: string,
): Promise<Device> {
  return mutateJson(
    `/admin/pairings/${encodeURIComponent(pairingId)}/approve`,
    "POST",
    csrfToken,
    { verificationCode },
    deviceSchema,
  );
}

export function revokeDevice(
  csrfToken: string,
  deviceId: string,
): Promise<boolean> {
  return mutateJson(
    `/admin/devices/${encodeURIComponent(deviceId)}/revoke`,
    "POST",
    csrfToken,
    undefined,
    revokedResponseSchema,
  ).then((response) => response.revoked);
}

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return requestJson(path, schema);
}

async function mutateJson<T>(
  path: string,
  method: "POST" | "PUT",
  csrfToken: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  return requestJson(path, schema, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-pocketpilot-csrf-token": csrfToken,
    },
    method,
  });
}

async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalidResponseError();
  }
  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(payload);
    if (parsedError.success) {
      throw new LocalAdminApiError(
        parsedError.data.code,
        parsedError.data.message,
      );
    }
    throw new LocalAdminApiError(
      "LOCAL_ADMIN_REQUEST_FAILED",
      `The local Agent returned HTTP ${response.status}.`,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw invalidResponseError();
  }
  return parsed.data;
}

function invalidResponseError(): LocalAdminApiError {
  return new LocalAdminApiError(
    "LOCAL_ADMIN_RESPONSE_INVALID",
    "The local Agent returned an invalid response.",
  );
}
