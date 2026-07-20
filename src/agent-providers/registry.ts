import { AgentProviderError } from "./errors.js";
import type {
  AgentCapabilitySnapshot,
  AgentProviderAdapter,
  AgentProviderDescriptor,
  AgentProviderReadinessRefreshOptions,
} from "./types.js";

/** Owns provider registration and diagnostics-safe discovery. */
export class AgentProviderRegistry {
  readonly #providers: ReadonlyMap<string, AgentProviderAdapter>;

  public constructor(adapters: readonly AgentProviderAdapter[]) {
    const providers = new Map<string, AgentProviderAdapter>();
    for (const adapter of adapters) {
      if (providers.has(adapter.descriptor.id)) {
        throw new Error(
          `Duplicate Agent provider registration: ${adapter.descriptor.id}`,
        );
      }
      providers.set(adapter.descriptor.id, adapter);
    }
    this.#providers = providers;
  }

  public descriptors(): AgentProviderDescriptor[] {
    return [...this.#providers.values()]
      .map((adapter) => sanitizeDescriptor(adapter.descriptor))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  public descriptor(providerId: string): AgentProviderDescriptor {
    return sanitizeDescriptor(this.get(providerId).descriptor);
  }

  /**
   * Refreshes every registered adapter's readiness cache when supported.
   * Adapters without `refreshReadiness` keep their current descriptor.
   */
  public async refreshDescriptors(
    options: AgentProviderReadinessRefreshOptions = {},
  ): Promise<void> {
    await Promise.all(
      [...this.#providers.values()].map(async (adapter) => {
        await adapter.refreshReadiness?.(options);
      }),
    );
  }

  /**
   * Refreshes one provider's readiness cache when supported, then returns the
   * sanitized descriptor snapshot.
   */
  public async refreshDescriptor(
    providerId: string,
    options: AgentProviderReadinessRefreshOptions = {},
  ): Promise<AgentProviderDescriptor> {
    const adapter = this.get(providerId);
    await adapter.refreshReadiness?.(options);
    return sanitizeDescriptor(adapter.descriptor);
  }

  public get(providerId: string): AgentProviderAdapter {
    const adapter = this.#providers.get(providerId);
    if (adapter === undefined) {
      throw new AgentProviderError(
        "AGENT_PROVIDER_NOT_FOUND",
        404,
        "The requested Agent provider is not registered.",
      );
    }
    return adapter;
  }

  public requireAvailable(providerId: string): AgentProviderAdapter {
    const adapter = this.get(providerId);
    if (adapter.descriptor.status !== "available") {
      throw new AgentProviderError(
        "AGENT_PROVIDER_UNAVAILABLE",
        409,
        "The requested Agent provider is not available.",
      );
    }
    return adapter;
  }
}

function sanitizeDescriptor(
  descriptor: AgentProviderDescriptor,
): AgentProviderDescriptor {
  return {
    ...(descriptor.capabilities === undefined
      ? {}
      : { capabilities: sanitizeCapabilities(descriptor.capabilities) }),
    displayName: descriptor.displayName,
    id: descriptor.id,
    ...(descriptor.protocolVersion === undefined
      ? {}
      : { protocolVersion: descriptor.protocolVersion }),
    ...(descriptor.reasonCode === undefined
      ? {}
      : { reasonCode: descriptor.reasonCode }),
    status: descriptor.status,
  };
}

function sanitizeCapabilities(
  capabilities: AgentCapabilitySnapshot,
): AgentCapabilitySnapshot {
  return {
    activeTurnSteering: capabilities.activeTurnSteering,
    approvals: capabilities.approvals,
    attachments: capabilities.attachments,
    effort: capabilities.effort,
    historyPagination: capabilities.historyPagination,
    interrupt: capabilities.interrupt,
    modes: capabilities.modes,
    models: capabilities.models,
    nativeActions: sanitizeNativeActions(capabilities.nativeActions),
    newConversation: capabilities.newConversation,
    resumeConversation: capabilities.resumeConversation,
    statusCatalogs: sanitizeStatusCatalogs(capabilities.statusCatalogs),
    streamProtocol: capabilities.streamProtocol,
    threadManagement: sanitizeThreadManagement(capabilities.threadManagement),
  };
}

function sanitizeThreadManagement(
  threadManagement: AgentCapabilitySnapshot["threadManagement"] | undefined,
): AgentCapabilitySnapshot["threadManagement"] {
  if (threadManagement === undefined || typeof threadManagement !== "object") {
    return {
      archive: false,
      delete: false,
      fork: false,
      includeArchived: false,
      search: false,
      unarchive: false,
    };
  }
  return {
    archive: threadManagement.archive === true,
    delete: threadManagement.delete === true,
    fork: threadManagement.fork === true,
    includeArchived: threadManagement.includeArchived === true,
    search: threadManagement.search === true,
    unarchive: threadManagement.unarchive === true,
  };
}

function sanitizeStatusCatalogs(
  statusCatalogs: AgentCapabilitySnapshot["statusCatalogs"] | undefined,
): AgentCapabilitySnapshot["statusCatalogs"] {
  if (statusCatalogs === undefined || typeof statusCatalogs !== "object") {
    return {};
  }
  const sanitized: AgentCapabilitySnapshot["statusCatalogs"] = {};
  if (statusCatalogs.account === true) {
    sanitized.account = true;
  }
  if (statusCatalogs.hooks === true) {
    sanitized.hooks = true;
  }
  if (statusCatalogs.mcpServers === true) {
    sanitized.mcpServers = true;
  }
  if (statusCatalogs.rateLimits === true) {
    sanitized.rateLimits = true;
  }
  if (statusCatalogs.skills === true) {
    sanitized.skills = true;
  }
  return sanitized;
}

function sanitizeNativeActions(
  nativeActions: AgentCapabilitySnapshot["nativeActions"],
): AgentCapabilitySnapshot["nativeActions"] {
  const sanitized: AgentCapabilitySnapshot["nativeActions"] = {};
  if (nativeActions.review !== undefined) {
    sanitized.review = {
      availability: "idle",
      deliveries: ["inline"] as const,
      method: nativeActions.review.method,
      startsTurn: true,
      targetTypes: [
        "uncommittedChanges",
        "baseBranch",
        "commit",
        "custom",
      ] as const,
    };
  }
  if (nativeActions.rename !== undefined) {
    sanitized.rename = {
      availability: "always",
      method: nativeActions.rename.method,
      startsTurn: false,
    };
  }
  if (nativeActions.compact !== undefined) {
    sanitized.compact = {
      availability: "idle",
      method: nativeActions.compact.method,
      startsTurn: true,
    };
  }
  return sanitized;
}
