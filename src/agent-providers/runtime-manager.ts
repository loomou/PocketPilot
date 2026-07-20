import { TaskError } from "../tasks/errors.js";
import type {
  TaskBoundOperationResult,
  TaskNullOperationResult,
  TaskSnapshot,
} from "../tasks/task-types.js";
import type { AgentProviderRegistry } from "./registry.js";
import type {
  AgentConversationArchiveInput,
  AgentConversationAttachInput,
  AgentConversationDeleteInput,
  AgentConversationForkInput,
  AgentConversationHistoryInput,
  AgentConversationListInput,
  AgentConversationOperationInput,
  AgentConversationPage,
  AgentConversationUnarchiveInput,
  AgentProviderAdapter,
  AgentProviderDescriptor,
} from "./types.js";

/** Provider-neutral orchestration for discovery and conversation resources. */
export class AgentRuntimeManager {
  public constructor(
    private readonly registry: AgentProviderRegistry,
    private readonly taskServices: {
      authorizeWorkspace(workspace: string): Promise<string>;
      getTask(taskId: string): TaskSnapshot;
    },
  ) {}

  public listProviders(): AgentProviderDescriptor[] {
    return this.registry.descriptors();
  }

  public providerCapabilities(providerId: string) {
    const descriptor = this.registry.descriptor(providerId);
    return {
      ...(descriptor.capabilities === undefined
        ? {}
        : { capabilities: descriptor.capabilities }),
      id: descriptor.id,
      ...(descriptor.protocolVersion === undefined
        ? {}
        : { protocolVersion: descriptor.protocolVersion }),
      status: descriptor.status,
    };
  }

  public provider(providerId: string): AgentProviderAdapter {
    return this.registry.requireAvailable(providerId);
  }

  public task(taskId: string): TaskSnapshot {
    return this.taskServices.getTask(taskId);
  }

  public taskProvider(taskId: string): AgentProviderAdapter {
    return this.provider(this.task(taskId).provider);
  }

  public async listConversations(
    providerId: string,
    input: AgentConversationListInput,
  ): Promise<AgentConversationPage<unknown>> {
    const provider = this.provider(providerId);
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.listConversations({ ...input, workspace });
  }

  public async readConversation(
    providerId: string,
    input: AgentConversationHistoryInput,
  ): Promise<AgentConversationPage<unknown>> {
    const provider = this.provider(providerId);
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.readConversation({ ...input, workspace });
  }

  public async createConversation(
    providerId: string,
    input: AgentConversationOperationInput,
  ): Promise<TaskBoundOperationResult> {
    const provider = this.provider(providerId);
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.createConversation({ ...input, workspace });
  }

  public async attachConversation(
    providerId: string,
    input: AgentConversationAttachInput,
  ): Promise<TaskBoundOperationResult> {
    const provider = this.provider(providerId);
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.attachConversation({ ...input, workspace });
  }

  public async forkConversation(
    providerId: string,
    input: AgentConversationForkInput,
  ): Promise<TaskBoundOperationResult> {
    const provider = this.provider(providerId);
    if (provider.forkConversation === undefined) {
      throw unsupportedThreadManagement("fork");
    }
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.forkConversation({ ...input, workspace });
  }

  public async archiveConversation(
    providerId: string,
    input: AgentConversationArchiveInput,
  ): Promise<TaskNullOperationResult> {
    const provider = this.provider(providerId);
    if (provider.archiveConversation === undefined) {
      throw unsupportedThreadManagement("archive");
    }
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.archiveConversation({ ...input, workspace });
  }

  public async unarchiveConversation(
    providerId: string,
    input: AgentConversationUnarchiveInput,
  ): Promise<TaskNullOperationResult> {
    const provider = this.provider(providerId);
    if (provider.unarchiveConversation === undefined) {
      throw unsupportedThreadManagement("unarchive");
    }
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.unarchiveConversation({ ...input, workspace });
  }

  public async deleteConversation(
    providerId: string,
    input: AgentConversationDeleteInput,
  ): Promise<TaskNullOperationResult> {
    const provider = this.provider(providerId);
    if (provider.deleteConversation === undefined) {
      throw unsupportedThreadManagement("delete");
    }
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.deleteConversation({ ...input, workspace });
  }
}

function unsupportedThreadManagement(operation: string): TaskError {
  return new TaskError(
    "TASK_CONTROL_NOT_SUPPORTED",
    409,
    `This provider does not support conversation ${operation}.`,
  );
}
