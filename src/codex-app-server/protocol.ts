import { z } from "zod";

import type {
  CodexClientFrame,
  CodexClientRequestFrame,
  CodexClientResponseFrame,
} from "./types.js";
import { isCodexJsonObject, isCodexRequestId } from "./types.js";

export const codexReadClientRequestMethods = [
  "collaborationMode/list",
  "model/list",
  "permissionProfile/list",
  "thread/items/list",
  "thread/read",
  "thread/turns/list",
] as const;

export const codexClientRequestMethods = [
  ...codexReadClientRequestMethods,
  "turn/interrupt",
  "turn/start",
  "turn/steer",
] as const;

export const codexForwardedServerRequestMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
] as const;

export const codexForwardedNotificationMethods = [
  "configWarning",
  "deprecationNotice",
  "error",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/completed",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "model/rerouted",
  "model/verification",
  "serverRequest/resolved",
  "thread/closed",
  "thread/compacted",
  "thread/name/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "turn/started",
  "warning",
] as const;

const requestIdSchema = z.union([
  z.number().int().safe(),
  z.string().min(1).max(256),
]);

const clientRequestSchema = z
  .object({
    id: requestIdSchema,
    method: z.enum(codexClientRequestMethods),
    params: z.object({}).passthrough(),
  })
  .passthrough();

const clientResponseSchema = z
  .object({
    id: requestIdSchema,
    result: z.unknown(),
  })
  .passthrough();

export function parseCodexClientFrame(
  frame: unknown,
  isBinary = false,
): CodexClientFrame | undefined {
  if (isBinary) {
    return undefined;
  }
  const text = decodeSocketMessage(frame);
  if (text === undefined || Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  const request = clientRequestSchema.safeParse(value);
  if (request.success) {
    return value as CodexClientRequestFrame;
  }
  const response = clientResponseSchema.safeParse(value);
  return response.success ? (value as CodexClientResponseFrame) : undefined;
}

export function isForwardedCodexNotification(method: string): boolean {
  return (codexForwardedNotificationMethods as readonly string[]).includes(
    method,
  );
}

export function isCodexClientRequestFrame(
  frame: CodexClientFrame,
): frame is CodexClientRequestFrame {
  return (
    isCodexJsonObject(frame) &&
    typeof frame.method === "string" &&
    isCodexRequestId(frame.id) &&
    isCodexJsonObject(frame.params)
  );
}

export function isCodexReadClientRequestMethod(method: string): boolean {
  return (codexReadClientRequestMethods as readonly string[]).includes(method);
}

export function isForwardedCodexServerRequest(method: string): boolean {
  return (codexForwardedServerRequestMethods as readonly string[]).includes(
    method,
  );
}

function decodeSocketMessage(message: unknown): string | undefined {
  if (typeof message === "string") {
    return message;
  }
  if (Buffer.isBuffer(message)) {
    return message.toString("utf8");
  }
  if (message instanceof ArrayBuffer) {
    return Buffer.from(message).toString("utf8");
  }
  if (Array.isArray(message) && message.every(Buffer.isBuffer)) {
    return Buffer.concat(message).toString("utf8");
  }
  return undefined;
}
