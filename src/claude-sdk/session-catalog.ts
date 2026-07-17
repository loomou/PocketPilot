import type {
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  ResolvedSettings,
  ResolveSettingsOptions,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  resolveSettings,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Injectable boundary around the installed SDK's supported session APIs.
 * SDK-owned rows are returned directly so PocketPilot never creates a second
 * session or transcript representation.
 */
export type ClaudeSessionCatalog = {
  getInfo(
    sessionId: string,
    options: GetSessionInfoOptions,
  ): Promise<SDKSessionInfo | undefined>;
  getMessages(
    sessionId: string,
    options: GetSessionMessagesOptions,
  ): Promise<SessionMessage[]>;
  list(options: ListSessionsOptions): Promise<SDKSessionInfo[]>;
  resolveSettings(options: ResolveSettingsOptions): Promise<ResolvedSettings>;
};

export type ClaudeSessionCatalogDependencies = {
  getSessionInfo: typeof getSessionInfo;
  getSessionMessages: typeof getSessionMessages;
  listSessions: typeof listSessions;
  resolveSettings: typeof resolveSettings;
};

export function createClaudeSessionCatalog(
  dependencies: ClaudeSessionCatalogDependencies,
): ClaudeSessionCatalog {
  return {
    getInfo(sessionId, options) {
      return dependencies.getSessionInfo(sessionId, options);
    },
    getMessages(sessionId, options) {
      return dependencies.getSessionMessages(sessionId, options);
    },
    list(options) {
      return dependencies.listSessions(options);
    },
    resolveSettings(options) {
      return dependencies.resolveSettings(options);
    },
  };
}

export const installedClaudeSessionCatalog = createClaudeSessionCatalog({
  getSessionInfo,
  getSessionMessages,
  listSessions,
  resolveSettings,
});
