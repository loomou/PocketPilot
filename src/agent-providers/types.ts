import type { TaskOperationResult, TaskSnapshot } from "../tasks/task-types.js";

export const agentProviderStatuses = [
  "available",
  "not_installed",
  "disabled",
  "unhealthy",
  "unsupported_version",
] as const;

export type AgentProviderStatus = (typeof agentProviderStatuses)[number];

export type AgentCapabilitySnapshot = {
  activeTurnSteering: boolean;
  approvals: boolean;
  attachments: boolean;
  effort: boolean;
  historyPagination: "cursor" | "offset" | "none";
  interrupt: boolean;
  modes: boolean;
  models: boolean;
  newConversation: boolean;
  resumeConversation: boolean;
  streamProtocol: string;
};

export type AgentProviderDescriptor = {
  capabilities?: AgentCapabilitySnapshot;
  displayName: string;
  id: string;
  protocolVersion?: string;
  reasonCode?: string;
  status: AgentProviderStatus;
};

export type AgentConversationListInput = {
  cursor?: string;
  limit?: number;
  workspace: string;
};

export type AgentConversationHistoryInput = {
  cursor?: string;
  includeSystemMessages?: boolean;
  limit?: number;
  nativeConversationId: string;
  workspace: string;
};

export type AgentConversationOperationInput = {
  deviceId: string;
  operationId: string;
  workspace: string;
  workspaceRiskAccepted: boolean;
};

export type AgentConversationAttachInput = AgentConversationOperationInput & {
  nativeConversationId: string;
};

export type AgentConversationPage<T> = {
  items: T[];
  page: {
    cursor: string | null;
    hasMore: boolean;
  };
};

export type AgentTaskStreamSubscriber<TMessage = unknown> = {
  send(message: TMessage): void;
};

export type AgentTaskStreamAdapter = {
  activate(taskId: string): Promise<void>;
  parseClientFrame(frame: unknown, isBinary: boolean): unknown | undefined;
  submit(input: {
    deviceId: string;
    message: unknown;
    taskId: string;
  }): Promise<TaskSnapshot>;
  subscribe(
    taskId: string,
    afterCursor: string | undefined,
    subscriber: AgentTaskStreamSubscriber,
  ): () => void;
};

export type AgentTaskLifecycleAdapter = {
  close(taskId: string): Promise<void>;
  interrupt(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
};

export type AgentTaskController = AgentTaskLifecycleAdapter;

/**
 * Provider-specific behavior behind the common Agent lifecycle.
 * Native rows and messages intentionally remain opaque to this layer.
 */
export interface AgentProviderAdapter {
  readonly descriptor: AgentProviderDescriptor;
  readonly taskLifecycle?: AgentTaskLifecycleAdapter;
  readonly taskStream: AgentTaskStreamAdapter;

  attachConversation(
    input: AgentConversationAttachInput,
  ): Promise<TaskOperationResult>;
  createConversation(
    input: AgentConversationOperationInput,
  ): Promise<TaskOperationResult>;
  listConversations(
    input: AgentConversationListInput,
  ): Promise<AgentConversationPage<unknown>>;
  readConversation(
    input: AgentConversationHistoryInput,
  ): Promise<AgentConversationPage<unknown>>;
}
