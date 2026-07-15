import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKPermissionDeniedMessage,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";

type OtherSystemMessage = Exclude<
  Extract<SDKMessage, { type: "system" }>,
  SDKPermissionDeniedMessage | SDKSessionStateChangedMessage | SDKSystemMessage
>;

type OtherSdkMessage = Exclude<
  SDKMessage,
  | SDKAssistantMessage
  | SDKPartialAssistantMessage
  | SDKPermissionDeniedMessage
  | SDKResultMessage
  | SDKSessionStateChangedMessage
  | SDKSystemMessage
  | OtherSystemMessage
  | Extract<SDKMessage, { type: "user" }>
>;

/**
 * The Agent owns this projection boundary. It intentionally excludes SDK user
 * messages: the mobile client already has the instruction it submitted, and
 * PocketPilot must not maintain a second canonical conversation transcript.
 */
export type NormalizedClaudeSdkEvent =
  | { kind: "assistant.message"; message: SDKAssistantMessage }
  | { kind: "assistant.stream-event"; message: SDKPartialAssistantMessage }
  | { kind: "permission.denied"; message: SDKPermissionDeniedMessage }
  | { kind: "session.initialized"; message: SDKSystemMessage }
  | { kind: "session.state-changed"; message: SDKSessionStateChangedMessage }
  | { kind: "sdk.message"; message: OtherSdkMessage }
  | { kind: "sdk.system"; message: OtherSystemMessage }
  | { kind: "turn.result"; message: SDKResultMessage };

/**
 * Projects only SDK output and lifecycle messages that PocketPilot may relay
 * or buffer for the active turn. Unknown SDK system subtypes remain typed
 * system events so an SDK upgrade does not silently discard them.
 */
export function normalizeSdkMessage(
  message: SDKMessage,
): NormalizedClaudeSdkEvent | undefined {
  switch (message.type) {
    case "assistant":
      return { kind: "assistant.message", message };
    case "result":
      return { kind: "turn.result", message };
    case "stream_event":
      return { kind: "assistant.stream-event", message };
    case "system":
      switch (message.subtype) {
        case "init":
          return { kind: "session.initialized", message };
        case "permission_denied":
          return { kind: "permission.denied", message };
        case "session_state_changed":
          return { kind: "session.state-changed", message };
        default:
          return { kind: "sdk.system", message };
      }
    case "user":
      return undefined;
    default:
      return { kind: "sdk.message", message };
  }
}
