import type {
  TaskBoundOperationResult,
  TaskNullOperationResult,
  TaskSnapshot,
} from "../tasks/task-types.js";

export const agentProviderStatuses = [
  "available",
  "not_installed",
  "disabled",
  "unhealthy",
  "unsupported_version",
] as const;

export type AgentProviderStatus = (typeof agentProviderStatuses)[number];

export type AgentNativeReviewAction = {
  availability: "idle";
  deliveries: readonly ["inline"];
  method: string;
  startsTurn: true;
  targetTypes: readonly [
    "uncommittedChanges",
    "baseBranch",
    "commit",
    "custom",
  ];
};

export type AgentNativeRenameAction = {
  availability: "always";
  method: string;
  startsTurn: false;
};

export type AgentNativeCompactAction = {
  availability: "idle";
  method: string;
  startsTurn: true;
};

export type AgentNativeActions = {
  compact?: AgentNativeCompactAction;
  rename?: AgentNativeRenameAction;
  review?: AgentNativeReviewAction;
};

export type AgentStatusCatalogs = {
  account?: true;
  hooks?: true;
  mcpServers?: true;
  rateLimits?: true;
  skills?: true;
};

export type AgentThreadManagementCapabilities = {
  archive: boolean;
  delete: boolean;
  fork: boolean;
  includeArchived: boolean;
  search: boolean;
  unarchive: boolean;
};

export type AgentCapabilitySnapshot = {
  activeTurnSteering: boolean;
  approvals: boolean;
  attachments: boolean;
  effort: boolean;
  historyPagination: "cursor" | "offset" | "none";
  interrupt: boolean;
  modes: boolean;
  models: boolean;
  nativeActions: AgentNativeActions;
  newConversation: boolean;
  resumeConversation: boolean;
  statusCatalogs: AgentStatusCatalogs;
  streamProtocol: string;
  threadManagement: AgentThreadManagementCapabilities;
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
  includeArchived?: boolean;
  limit?: number;
  searchTerm?: string;
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

export type AgentConversationForkInput = AgentConversationOperationInput & {
  nativeConversationId: string;
};

export type AgentConversationArchiveInput = AgentConversationOperationInput & {
  /**
   * Successful archives require `true`. Missing/false values must surface
   * `CONFIRMATION_REQUIRED` instead of a schema validation failure.
   */
  confirm?: boolean;
  nativeConversationId: string;
};

export type AgentConversationUnarchiveInput =
  AgentConversationOperationInput & {
    nativeConversationId: string;
  };

export type AgentConversationDeleteInput = AgentConversationOperationInput & {
  /**
   * Successful deletes require `true`. Missing/false values must surface
   * `CONFIRMATION_REQUIRED` instead of a schema validation failure.
   */
  confirm?: boolean;
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

  archiveConversation?(
    input: AgentConversationArchiveInput,
  ): Promise<TaskNullOperationResult>;
  attachConversation(
    input: AgentConversationAttachInput,
  ): Promise<TaskBoundOperationResult>;
  createConversation(
    input: AgentConversationOperationInput,
  ): Promise<TaskBoundOperationResult>;
  deleteConversation?(
    input: AgentConversationDeleteInput,
  ): Promise<TaskNullOperationResult>;
  forkConversation?(
    input: AgentConversationForkInput,
  ): Promise<TaskBoundOperationResult>;
  listConversations(
    input: AgentConversationListInput,
  ): Promise<AgentConversationPage<unknown>>;
  readConversation(
    input: AgentConversationHistoryInput,
  ): Promise<AgentConversationPage<unknown>>;
  unarchiveConversation?(
    input: AgentConversationUnarchiveInput,
  ): Promise<TaskNullOperationResult>;
}
