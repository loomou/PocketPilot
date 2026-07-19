export type CodexRequestId = number | string;

export type CodexJsonObject = Record<string, unknown>;

export type CodexClientRequestFrame = CodexJsonObject & {
  id: CodexRequestId;
  method: string;
  params: CodexJsonObject;
};

export type CodexClientResponseFrame = CodexJsonObject & {
  id: CodexRequestId;
  result: unknown;
};

export type CodexClientFrame =
  | CodexClientRequestFrame
  | CodexClientResponseFrame;

export type CodexServerFrame = CodexJsonObject;

export type CodexBridgeDelivery = {
  frame: CodexServerFrame;
  taskId?: string;
};

export type CodexInitializeInfo = {
  cliVersion: string;
  platformFamily: string;
  platformOs: string;
  userAgent: string;
};

export function isCodexJsonObject(value: unknown): value is CodexJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCodexRequestId(value: unknown): value is CodexRequestId {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 256) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}
