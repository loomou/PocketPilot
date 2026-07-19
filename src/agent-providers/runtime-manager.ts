import type { TaskSnapshot } from "../tasks/task-types.js";
import type { AgentProviderRegistry } from "./registry.js";
import type {
  AgentConversationAttachInput,
  AgentConversationHistoryInput,
  AgentConversationListInput,
  AgentConversationOperationInput,
  AgentConversationPage,
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
  ) {
    const provider = this.provider(providerId);
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.createConversation({ ...input, workspace });
  }

  public async attachConversation(
    providerId: string,
    input: AgentConversationAttachInput,
  ) {
    const provider = this.provider(providerId);
    const workspace = await this.taskServices.authorizeWorkspace(
      input.workspace,
    );
    return provider.attachConversation({ ...input, workspace });
  }
}
