import { AgentProviderError } from "./errors.js";
import type {
  AgentCapabilitySnapshot,
  AgentProviderAdapter,
  AgentProviderDescriptor,
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
    streamProtocol: capabilities.streamProtocol,
  };
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
