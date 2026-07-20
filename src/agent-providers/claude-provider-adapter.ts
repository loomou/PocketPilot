import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { claudeAgentSdkProtocolVersion } from "../claude-sdk/session.js";
import {
  parseSdkUserMessageFrame,
  sdkUserMessageTransportSchema,
} from "../claude-sdk/transport.js";
import type { TaskEventJournal } from "../tasks/task-event-journal.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type {
  TaskBoundOperationResult,
  TaskSnapshot,
} from "../tasks/task-types.js";
import type {
  AgentConversationAttachInput,
  AgentConversationHistoryInput,
  AgentConversationListInput,
  AgentConversationOperationInput,
  AgentConversationPage,
  AgentProviderAdapter,
  AgentProviderDescriptor,
  AgentProviderReadinessRefreshOptions,
  AgentProviderStatus,
  AgentTaskStreamAdapter,
} from "./types.js";
import { PROVIDER_READINESS_TTL_MS } from "./types.js";

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

export type ClaudeProviderAdapterOptions = {
  now?: () => number;
  probeSdk?: () => Promise<ClaudeReadinessSnapshot> | ClaudeReadinessSnapshot;
  readinessTtlMs?: number;
};

export type ClaudeReadinessSnapshot = {
  protocolVersion?: string;
  reasonCode?: string;
  status: AgentProviderStatus;
};

const CLAUDE_CAPABILITIES = {
  activeTurnSteering: true,
  approvals: true,
  attachments: false,
  effort: true,
  historyPagination: "cursor" as const,
  interrupt: true,
  modes: true,
  models: true,
  nativeActions: {},
  newConversation: true,
  resumeConversation: true,
  statusCatalogs: {},
  streamProtocol: "claude-agent-sdk" as const,
  threadManagement: {
    archive: false,
    delete: false,
    fork: false,
    includeArchived: false,
    search: false,
    unarchive: false,
  },
};

/** Keeps Claude SDK types and lifecycle semantics inside one provider adapter. */
export class ClaudeProviderAdapter implements AgentProviderAdapter {
  public readonly taskStream: AgentTaskStreamAdapter;
  readonly #now: () => number;
  readonly #probeSdk: () =>
    | Promise<ClaudeReadinessSnapshot>
    | ClaudeReadinessSnapshot;
  readonly #readinessTtlMs: number;
  #descriptor: AgentProviderDescriptor;
  #inFlightProbe: Promise<void> | undefined;
  #readinessCheckedAt = 0;

  public get descriptor(): AgentProviderDescriptor {
    return this.#descriptor;
  }

  public constructor(
    private readonly taskManager: ClaudeProviderTaskManager,
    eventJournal: ClaudeProviderEventJournal,
    options: ClaudeProviderAdapterOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#probeSdk = options.probeSdk ?? defaultClaudeSdkProbe;
    this.#readinessTtlMs = options.readinessTtlMs ?? PROVIDER_READINESS_TTL_MS;
    this.#descriptor = {
      capabilities: { ...CLAUDE_CAPABILITIES },
      displayName: "Claude Code",
      id: "claude",
      protocolVersion: claudeAgentSdkProtocolVersion,
      status: "available",
    };
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

  public async refreshReadiness(
    options: AgentProviderReadinessRefreshOptions = {},
  ): Promise<void> {
    const force = options.force === true;
    const ageMs = this.#now() - this.#readinessCheckedAt;
    if (
      !force &&
      this.#readinessCheckedAt > 0 &&
      ageMs < this.#readinessTtlMs
    ) {
      return;
    }
    if (this.#inFlightProbe !== undefined) {
      await this.#inFlightProbe;
      return;
    }
    this.#inFlightProbe = this.#runProbe();
    try {
      await this.#inFlightProbe;
    } finally {
      this.#inFlightProbe = undefined;
    }
  }

  async #runProbe(): Promise<void> {
    try {
      const snapshot = await this.#probeSdk();
      this.#applySnapshot(snapshot);
    } catch {
      this.#applySnapshot({
        reasonCode: "CLAUDE_SDK_PROBE_FAILED",
        status: "unhealthy",
      });
    } finally {
      this.#readinessCheckedAt = this.#now();
    }
  }

  #applySnapshot(snapshot: ClaudeReadinessSnapshot): void {
    const next: AgentProviderDescriptor = {
      displayName: "Claude Code",
      id: "claude",
      status: snapshot.status,
    };
    if (snapshot.status === "available") {
      next.capabilities = { ...CLAUDE_CAPABILITIES };
      next.protocolVersion =
        snapshot.protocolVersion ?? claudeAgentSdkProtocolVersion;
    } else if (snapshot.protocolVersion !== undefined) {
      next.protocolVersion = snapshot.protocolVersion;
    }
    if (snapshot.reasonCode !== undefined) {
      next.reasonCode = snapshot.reasonCode;
    }
    this.#descriptor = next;
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
  ): Promise<TaskBoundOperationResult> {
    return this.taskManager.createClaudeConversation(input);
  }

  public attachConversation(
    input: AgentConversationAttachInput,
  ): Promise<TaskBoundOperationResult> {
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

async function defaultClaudeSdkProbe(): Promise<ClaudeReadinessSnapshot> {
  try {
    await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    return {
      reasonCode: "CLAUDE_SDK_NOT_AVAILABLE",
      status: "not_installed",
    };
  }
  if (
    typeof claudeAgentSdkProtocolVersion !== "string" ||
    claudeAgentSdkProtocolVersion.length === 0
  ) {
    return {
      reasonCode: "CLAUDE_SDK_VERSION_UNSUPPORTED",
      status: "unsupported_version",
    };
  }
  return {
    protocolVersion: claudeAgentSdkProtocolVersion,
    status: "available",
  };
}
