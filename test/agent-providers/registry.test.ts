import { describe, expect, it } from "vitest";
import { AgentProviderError } from "../../src/agent-providers/errors.js";
import { AgentProviderRegistry } from "../../src/agent-providers/registry.js";
import type {
  AgentCapabilitySnapshot,
  AgentProviderAdapter,
} from "../../src/agent-providers/types.js";

function fakeProvider(
  id: string,
  status: AgentProviderAdapter["descriptor"]["status"] = "available",
): AgentProviderAdapter {
  return {
    descriptor: {
      displayName: id,
      id,
      reasonCode: "LOCAL_TEST",
      status,
    },
    taskStream: {
      activate: async () => undefined,
      parseClientFrame: () => undefined,
      submit: async () => {
        throw new Error("not used");
      },
      subscribe: () => () => undefined,
    },
    attachConversation: async () => {
      throw new Error("not used");
    },
    createConversation: async () => {
      throw new Error("not used");
    },
    listConversations: async () => ({
      items: [],
      page: { cursor: null, hasMore: false },
    }),
    readConversation: async () => ({
      items: [],
      page: { cursor: null, hasMore: false },
    }),
  };
}

describe("AgentProviderRegistry", () => {
  it("discovers unavailable providers without hiding them", () => {
    const registry = new AgentProviderRegistry([
      fakeProvider("codex", "not_installed"),
      fakeProvider("claude"),
    ]);

    expect(registry.descriptors()).toEqual([
      {
        displayName: "claude",
        id: "claude",
        reasonCode: "LOCAL_TEST",
        status: "available",
      },
      {
        displayName: "codex",
        id: "codex",
        reasonCode: "LOCAL_TEST",
        status: "not_installed",
      },
    ]);
  });

  it("rejects unknown and unavailable providers at the execution boundary", () => {
    const registry = new AgentProviderRegistry([
      fakeProvider("codex", "disabled"),
    ]);

    expect(() => registry.get("missing")).toThrowError(
      new AgentProviderError(
        "AGENT_PROVIDER_NOT_FOUND",
        404,
        "The requested Agent provider is not registered.",
      ),
    );
    expect(() => registry.requireAvailable("codex")).toThrowError(
      new AgentProviderError(
        "AGENT_PROVIDER_UNAVAILABLE",
        409,
        "The requested Agent provider is not available.",
      ),
    );
  });

  it("rejects duplicate provider IDs during registration", () => {
    expect(
      () =>
        new AgentProviderRegistry([
          fakeProvider("claude"),
          fakeProvider("claude"),
        ]),
    ).toThrow("Duplicate Agent provider registration: claude");
  });

  it("projects only diagnostics-safe descriptor and capability fields", () => {
    const adapter = fakeProvider("claude");
    adapter.descriptor.capabilities = {
      activeTurnSteering: true,
      approvals: true,
      attachments: false,
      effort: true,
      historyPagination: "cursor",
      interrupt: true,
      modes: true,
      models: true,
      nativeActions: {
        review: {
          availability: "idle",
          deliveries: ["inline"],
          method: "review/start",
          startsTurn: true,
          targetTypes: ["uncommittedChanges", "baseBranch", "commit", "custom"],
        },
      },
      newConversation: true,
      resumeConversation: true,
      statusCatalogs: {
        account: true,
        skills: true,
        experimentalCatalog: true,
      } as NonNullable<
        AgentProviderAdapter["descriptor"]["capabilities"]
      >["statusCatalogs"],
      streamProtocol: "claude-agent-sdk",
      executablePath: "C:\\secret\\claude.exe",
      secretNativeFlag: true,
    } as unknown as AgentCapabilitySnapshot;
    Object.assign(adapter.descriptor, {
      configPath: "C:\\secret\\config.json",
      rawProcessError: "credential-bearing error",
    });

    const registry = new AgentProviderRegistry([adapter]);
    const serialized = JSON.stringify(registry.descriptor("claude"));
    expect(serialized).not.toContain("executablePath");
    expect(serialized).not.toContain("configPath");
    expect(serialized).not.toContain("rawProcessError");
    expect(serialized).not.toContain("secretNativeFlag");
    expect(serialized).not.toContain("C:\\\\secret");
    expect(registry.descriptor("claude").capabilities).toEqual({
      activeTurnSteering: true,
      approvals: true,
      attachments: false,
      effort: true,
      historyPagination: "cursor",
      interrupt: true,
      modes: true,
      models: true,
      nativeActions: {
        review: {
          availability: "idle",
          deliveries: ["inline"],
          method: "review/start",
          startsTurn: true,
          targetTypes: ["uncommittedChanges", "baseBranch", "commit", "custom"],
        },
      },
      newConversation: true,
      resumeConversation: true,
      statusCatalogs: {
        account: true,
        skills: true,
      },
      streamProtocol: "claude-agent-sdk",
      threadManagement: {
        archive: false,
        delete: false,
        fork: false,
        includeArchived: false,
        search: false,
        unarchive: false,
      },
    });
  });

  it("sanitizes threadManagement into a closed boolean capability object", () => {
    const adapter = fakeProvider("codex");
    adapter.descriptor.capabilities = {
      activeTurnSteering: true,
      approvals: true,
      attachments: false,
      effort: true,
      historyPagination: "cursor",
      interrupt: true,
      modes: true,
      models: true,
      nativeActions: {},
      newConversation: true,
      resumeConversation: true,
      statusCatalogs: {},
      streamProtocol: "codex-app-server-json-rpc",
      threadManagement: {
        archive: true,
        delete: "yes",
        fork: true,
        includeArchived: 1,
        search: true,
        unarchive: false,
        experimental: true,
      },
    } as unknown as NonNullable<
      AgentProviderAdapter["descriptor"]["capabilities"]
    >;

    expect(
      new AgentProviderRegistry([adapter]).descriptor("codex").capabilities
        ?.threadManagement,
    ).toEqual({
      archive: true,
      delete: false,
      fork: true,
      includeArchived: false,
      search: true,
      unarchive: false,
    });
  });
});
