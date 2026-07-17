import type {
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  ResolveSettingsOptions,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import {
  type ClaudeSessionCatalogDependencies,
  createClaudeSessionCatalog,
} from "../../src/claude-sdk/session-catalog.js";

describe("Claude session catalog adapter", () => {
  it("delegates supported SDK calls and preserves returned objects", async () => {
    const session = {
      futureSdkField: { preserved: true },
      lastModified: 1,
      sessionId: "session-1",
      summary: "Session",
    } as SDKSessionInfo;
    const message = {
      futureSdkField: { preserved: true },
      message: { content: "hello" },
      parent_agent_id: null,
      parent_tool_use_id: null,
      session_id: "session-1",
      type: "user",
      uuid: "message-1",
    } as SessionMessage;
    const calls: Array<{ name: string; options: unknown }> = [];
    const dependencies: ClaudeSessionCatalogDependencies = {
      async getSessionInfo(
        _sessionId: string,
        options?: GetSessionInfoOptions,
      ) {
        calls.push({ name: "info", options });
        return session;
      },
      async getSessionMessages(
        _sessionId: string,
        options?: GetSessionMessagesOptions,
      ) {
        calls.push({ name: "messages", options });
        return [message];
      },
      async listSessions(options?: ListSessionsOptions) {
        calls.push({ name: "list", options });
        return [session];
      },
      async resolveSettings(options?: ResolveSettingsOptions) {
        calls.push({ name: "settings", options });
        return { effective: {}, provenance: {}, sources: [] };
      },
    };
    const catalog = createClaudeSessionCatalog(dependencies);

    const listed = await catalog.list({
      dir: "C:\\workspace",
      includeProgrammatic: true,
      includeWorktrees: false,
      limit: 25,
      offset: 50,
    });
    const info = await catalog.getInfo("session-1", {
      dir: "C:\\workspace",
    });
    const messages = await catalog.getMessages("session-1", {
      dir: "C:\\workspace",
      includeSystemMessages: true,
    });
    await catalog.resolveSettings({ cwd: "C:\\workspace" });

    expect(listed[0]).toBe(session);
    expect(info).toBe(session);
    expect(messages[0]).toBe(message);
    expect(calls).toEqual([
      {
        name: "list",
        options: {
          dir: "C:\\workspace",
          includeProgrammatic: true,
          includeWorktrees: false,
          limit: 25,
          offset: 50,
        },
      },
      { name: "info", options: { dir: "C:\\workspace" } },
      {
        name: "messages",
        options: {
          dir: "C:\\workspace",
          includeSystemMessages: true,
        },
      },
      { name: "settings", options: { cwd: "C:\\workspace" } },
    ]);
  });
});
