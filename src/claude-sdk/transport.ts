import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const sdkUserMessageTransportSchema = z
  .object({
    isSynthetic: z.boolean().optional(),
    message: z
      .object({
        content: z.union([z.string(), z.array(z.unknown())]),
        role: z.literal("user"),
      })
      .passthrough(),
    origin: z.object({}).passthrough().optional(),
    parent_tool_use_id: z.string().nullable(),
    priority: z.enum(["now", "next", "later"]).optional(),
    session_id: z.string().optional(),
    shouldQuery: z.boolean().optional(),
    timestamp: z.string().optional(),
    type: z.literal("user"),
    uuid: z.string().optional(),
  })
  .passthrough()
  .describe(
    "Raw SDKUserMessage transport base. The installed SDK owns optional and future fields.",
  );

export function parseSdkUserMessageFrame(
  frame: unknown,
  isBinary = false,
): SDKUserMessage | undefined {
  if (isBinary) {
    return undefined;
  }
  const text = decodeSocketMessage(frame);
  if (text === undefined) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!sdkUserMessageTransportSchema.safeParse(value).success) {
    return undefined;
  }
  return value as SDKUserMessage;
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
