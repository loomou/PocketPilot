import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { claudeAgentSdkProtocolVersion } from "../claude-sdk/session.js";
import {
  parseSdkUserMessageFrame,
  sdkUserMessageTransportSchema,
} from "../claude-sdk/transport.js";
import type { TaskEventJournal } from "../tasks/task-event-journal.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskOperationResult, TaskSnapshot } from "../tasks/task-types.js";
import type {
  AgentConversationAttachInput,
  AgentConversationHistoryInput,
  AgentConversationListInput,
  AgentConversationOperationInput,
  AgentConversationPage,
  AgentProviderAdapter,
  AgentTaskStreamAdapter,
} from "./types.js";

type ClaudeProviderTaskManager = Pick<
  TaskManager,
  | "activateSdkSession"
  | "attachClaudeSession"
  | "createClaudeConversation"
  | "getTask"
  | "listClaudeSessions"
  | "readClaudeSessionHistory"
  | "submitSdkMessage"
>;

type ClaudeProviderEventJournal = Pick<TaskEventJournal, "subscribeSdk">;

/** Keeps Claude SDK types and lifecycle semantics inside one provider adapter. */
export class ClaudeProviderAdapter implements AgentProviderAdapter {
  public readonly descriptor = {
    capabilities: {
      activeTurnSteering: true,
      approvals: true,
      attachments: false,
      effort: true,
      historyPagination: "cursor" as const,
      interrupt: true,
      modes: true,
      models: true,
      newConversation: true,
      resumeConversation: true,
      streamProtocol: "claude-agent-sdk" as const,
    },
    displayName: "Claude Code",
    id: "claude",
    protocolVersion: claudeAgentSdkProtocolVersion,
    status: "available" as const,
  };

  public readonly taskStream: AgentTaskStreamAdapter;

  public constructor(
    private readonly taskManager: ClaudeProviderTaskManager,
    eventJournal: ClaudeProviderEventJournal,
  ) {
    this.taskStream = {
      activate: (taskId) => this.taskManager.activateSdkSession(taskId),
      parseClientFrame: (frame, isBinary) =>
        parseSdkUserMessageFrame(frame, isBinary),
      submit: (input) => this.submitSdkMessage(input),
      subscribe: (taskId, afterCursor, subscriber) =>
        eventJournal.subscribeSdk(taskId, afterCursor, {
          send(message): void {
            subscriber.send(message);
          },
        }),
    };
  }

  public async listConversations(
    input: AgentConversationListInput,
  ): Promise<AgentConversationPage<unknown>> {
    const result = await this.taskManager.listClaudeSessions({
      ...(input.cursor === undefined
        ? {}
        : { offset: parseOffsetCursor(input.cursor) }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      workspace: input.workspace,
    });
    return {
      items: result.sessions,
      page: {
        cursor: result.nextOffset === null ? null : String(result.nextOffset),
        hasMore: result.nextOffset !== null,
      },
    };
  }

  public async readConversation(
    input: AgentConversationHistoryInput,
  ): Promise<AgentConversationPage<unknown>> {
    const result = await this.taskManager.readClaudeSessionHistory({
      ...(input.cursor === undefined ? {} : { beforeUuid: input.cursor }),
      ...(input.includeSystemMessages === undefined
        ? {}
        : { includeSystemMessages: input.includeSystemMessages }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      sessionId: input.nativeConversationId,
      workspace: input.workspace,
    });
    return {
      items: result.messages,
      page: {
        cursor: result.page.beforeUuid,
        hasMore: result.page.hasMoreBefore,
      },
    };
  }

  public createConversation(
    input: AgentConversationOperationInput,
  ): Promise<TaskOperationResult> {
    return this.taskManager.createClaudeConversation(input);
  }

  public attachConversation(
    input: AgentConversationAttachInput,
  ): Promise<TaskOperationResult> {
    return this.taskManager.attachClaudeSession({
      ...input,
      sessionId: input.nativeConversationId,
    });
  }

  private submitSdkMessage(input: {
    deviceId: string;
    message: unknown;
    taskId: string;
  }): Promise<TaskSnapshot> {
    if (!sdkUserMessageTransportSchema.safeParse(input.message).success) {
      throw new Error("The Claude SDK user message is invalid.");
    }
    return this.taskManager.submitSdkMessage({
      deviceId: input.deviceId,
      message: input.message as SDKUserMessage,
      taskId: input.taskId,
    });
  }
}

function parseOffsetCursor(cursor: string): number {
  if (!/^\d+$/.test(cursor)) {
    throw new Error("The Claude conversation cursor is invalid.");
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new Error("The Claude conversation cursor is invalid.");
  }
  return offset;
}
