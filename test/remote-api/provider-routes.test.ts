import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { AgentProviderRegistry } from "../../src/agent-providers/registry.js";
import { AgentRuntimeManager } from "../../src/agent-providers/runtime-manager.js";
import type { AgentProviderAdapter } from "../../src/agent-providers/types.js";
import type { RemoteApiDeviceAuthService } from "../../src/remote-api/app.js";
import { buildRemoteApiApp } from "../../src/remote-api/app.js";
import { TaskError } from "../../src/tasks/errors.js";
import type { TaskSnapshot } from "../../src/tasks/task-types.js";

const deviceId = "00000000-0000-4000-8000-000000000001";

describe("provider routes", () => {
  const apps: Array<Awaited<ReturnType<typeof buildRemoteApiApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("discovers and exercises a fake provider without route conditionals", async () => {
    const calls: Array<{ name: string; value: unknown }> = [];
    const adapter = fakeProvider(calls);
    const runtime = new AgentRuntimeManager(
      new AgentProviderRegistry([adapter]),
      {
        authorizeWorkspace: async (workspace) => workspace,
        getTask: () => taskSnapshot("fake"),
      },
    );
    const app = await buildRemoteApiApp({
      agentRuntimeManager: runtime,
      deviceAuthService: deviceAuthService(),
    });
    apps.push(app);

    const providers = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "GET",
      url: "/v1/providers",
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toEqual({
      providers: [adapter.descriptor],
    });
    expect(providers.json().providers[0].capabilities.nativeActions).toEqual(
      {},
    );
    expect(providers.json().providers[0].capabilities.attachments).toBe(false);

    const list = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "GET",
      url: "/v1/providers/fake/conversations?workspace=C%3A%5Cworkspace&cursor=next&limit=7",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      conversations: [{ native: true }],
      page: { cursor: null, hasMore: false },
    });
    expect(calls).toContainEqual({
      name: "list",
      value: { cursor: "next", limit: 7, workspace: "C:\\workspace" },
    });

    const operationId = randomUUID();
    const created = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "POST",
      payload: {
        operationId,
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: "/v1/providers/fake/conversations",
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().task.provider).toBe("fake");
    expect(calls).toContainEqual({
      name: "create",
      value: {
        deviceId,
        operationId,
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
    });
  });

  it("requires authentication and returns stable unavailable-provider errors", async () => {
    const adapter = fakeProvider([], "disabled");
    const runtime = new AgentRuntimeManager(
      new AgentProviderRegistry([adapter]),
      {
        authorizeWorkspace: async (workspace) => workspace,
        getTask: () => taskSnapshot("fake"),
      },
    );
    const app = await buildRemoteApiApp({
      agentRuntimeManager: runtime,
      deviceAuthService: deviceAuthService(),
    });
    apps.push(app);

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/v1/providers",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const unavailable = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "GET",
      url: "/v1/providers/fake/conversations?workspace=C%3A%5Cworkspace",
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toEqual({
      code: "AGENT_PROVIDER_UNAVAILABLE",
      message: "The requested Agent provider is not available.",
    });
  });

  it("enforces common workspace authorization before calling a provider", async () => {
    const calls: Array<{ name: string; value: unknown }> = [];
    const runtime = new AgentRuntimeManager(
      new AgentProviderRegistry([fakeProvider(calls)]),
      {
        authorizeWorkspace: async () => {
          throw new TaskError(
            "WORKSPACE_NOT_AUTHORIZED",
            403,
            "The requested working directory is not an authorized workspace.",
          );
        },
        getTask: () => taskSnapshot("fake"),
      },
    );
    const app = await buildRemoteApiApp({
      agentRuntimeManager: runtime,
      deviceAuthService: deviceAuthService(),
    });
    apps.push(app);

    const response = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "GET",
      url: "/v1/providers/fake/conversations?workspace=C%3A%5Coutside",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      code: "WORKSPACE_NOT_AUTHORIZED",
      message:
        "The requested working directory is not an authorized workspace.",
    });
    expect(calls).toEqual([]);
  });

  it("forwards list filters and thread-management operations", async () => {
    const calls: Array<{ name: string; value: unknown }> = [];
    const adapter = fakeProvider(calls);
    const runtime = new AgentRuntimeManager(
      new AgentProviderRegistry([adapter]),
      {
        authorizeWorkspace: async (workspace) => workspace,
        getTask: () => taskSnapshot("fake"),
      },
    );
    const app = await buildRemoteApiApp({
      agentRuntimeManager: runtime,
      deviceAuthService: deviceAuthService(),
    });
    apps.push(app);

    const list = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "GET",
      url: "/v1/providers/fake/conversations?workspace=C%3A%5Cworkspace&includeArchived=true&searchTerm=review",
    });
    expect(list.statusCode).toBe(200);
    expect(calls[0]).toEqual({
      name: "list",
      value: {
        includeArchived: true,
        searchTerm: "review",
        workspace: "C:\\workspace",
      },
    });

    const operationId = randomUUID();
    const fork = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "POST",
      payload: {
        operationId,
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: "/v1/providers/fake/conversations/native-1/fork",
    });
    expect(fork.statusCode).toBe(200);
    expect(fork.json().action).toBe("forked");

    const archiveUnconfirmed = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "POST",
      payload: {
        operationId: randomUUID(),
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: "/v1/providers/fake/conversations/native-1/archive",
    });
    expect(archiveUnconfirmed.statusCode).toBe(409);
    expect(archiveUnconfirmed.json()).toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });

    const archive = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "POST",
      payload: {
        confirm: true,
        operationId: randomUUID(),
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: "/v1/providers/fake/conversations/native-1/archive",
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json()).toEqual({ action: "archived", task: null });

    const unarchive = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "POST",
      payload: {
        operationId: randomUUID(),
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: "/v1/providers/fake/conversations/native-1/unarchive",
    });
    expect(unarchive.statusCode).toBe(200);
    expect(unarchive.json().action).toBe("unarchived");

    const deleteUnconfirmed = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "POST",
      payload: {
        operationId: randomUUID(),
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: "/v1/providers/fake/conversations/native-1/delete",
    });
    expect(deleteUnconfirmed.statusCode).toBe(409);
    expect(deleteUnconfirmed.json()).toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });

    const deleteRejected = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "POST",
      payload: {
        confirm: false,
        operationId: randomUUID(),
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: "/v1/providers/fake/conversations/native-1/delete",
    });
    expect(deleteRejected.statusCode).toBe(409);
    expect(deleteRejected.json()).toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });

    const deleted = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "POST",
      payload: {
        confirm: true,
        operationId: randomUUID(),
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: "/v1/providers/fake/conversations/native-1/delete",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ action: "deleted", task: null });

    expect(calls.map((call) => call.name)).toEqual([
      "list",
      "fork",
      "archive",
      "archive",
      "unarchive",
      "delete",
      "delete",
      "delete",
    ]);
  });

  it("refreshes provider readiness on discovery and capabilities", async () => {
    let probes = 0;
    const calls: Array<{ name: string; value: unknown }> = [];
    const adapter = fakeProvider(calls, "not_installed") as ReturnType<
      typeof fakeProvider
    > & {
      descriptor: {
        capabilities?: unknown;
        displayName: string;
        id: string;
        protocolVersion?: string;
        reasonCode?: string;
        status: string;
      };
      refreshReadiness?: () => Promise<void>;
    };
    // Keep id consistent with route paths while still starting unavailable.
    adapter.descriptor = {
      displayName: "Fake",
      id: "fake",
      reasonCode: "STALE",
      status: "not_installed",
    };
    adapter.refreshReadiness = async () => {
      probes += 1;
      adapter.descriptor = {
        capabilities: {
          activeTurnSteering: true,
          approvals: false,
          attachments: false,
          effort: false,
          historyPagination: "cursor",
          interrupt: true,
          modes: false,
          models: false,
          nativeActions: {},
          newConversation: true,
          resumeConversation: true,
          statusCatalogs: {},
          streamProtocol: "test",
          threadManagement: {
            archive: false,
            delete: false,
            fork: false,
            includeArchived: false,
            search: false,
            unarchive: false,
          },
        },
        displayName: "Fake",
        id: "fake",
        protocolVersion: "fake-1",
        status: "available",
      };
    };
    const runtime = new AgentRuntimeManager(
      new AgentProviderRegistry([adapter]),
      {
        authorizeWorkspace: async (workspace) => workspace,
        getTask: () => taskSnapshot("fake"),
      },
    );
    const app = await buildRemoteApiApp({
      agentRuntimeManager: runtime,
      deviceAuthService: deviceAuthService(),
    });
    apps.push(app);

    const providers = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "GET",
      url: "/v1/providers",
    });
    expect(providers.statusCode).toBe(200);
    expect(probes).toBe(1);
    expect(providers.json()).toEqual({
      providers: [
        {
          capabilities: {
            activeTurnSteering: true,
            approvals: false,
            attachments: false,
            effort: false,
            historyPagination: "cursor",
            interrupt: true,
            modes: false,
            models: false,
            nativeActions: {},
            newConversation: true,
            resumeConversation: true,
            statusCatalogs: {},
            streamProtocol: "test",
            threadManagement: {
              archive: false,
              delete: false,
              fork: false,
              includeArchived: false,
              search: false,
              unarchive: false,
            },
          },
          displayName: "Fake",
          id: "fake",
          protocolVersion: "fake-1",
          status: "available",
        },
      ],
    });

    const capabilities = await app.inject({
      headers: { authorization: "Bearer access-token" },
      method: "GET",
      url: "/v1/providers/fake/capabilities",
    });
    expect(capabilities.statusCode).toBe(200);
    expect(probes).toBe(2);
    expect(capabilities.json()).toMatchObject({
      id: "fake",
      protocolVersion: "fake-1",
      status: "available",
    });
    expect(capabilities.json().reasonCode).toBeUndefined();
  });
});

function fakeProvider(
  calls: Array<{ name: string; value: unknown }>,
  status: AgentProviderAdapter["descriptor"]["status"] = "available",
): AgentProviderAdapter {
  return {
    descriptor: {
      capabilities: {
        activeTurnSteering: true,
        approvals: false,
        attachments: false,
        effort: false,
        historyPagination: "cursor",
        interrupt: true,
        modes: false,
        models: false,
        nativeActions: {},
        newConversation: true,
        resumeConversation: true,
        statusCatalogs: {},
        streamProtocol: "fake-native",
        threadManagement: {
          archive: true,
          delete: true,
          fork: true,
          includeArchived: true,
          search: true,
          unarchive: true,
        },
      },
      displayName: "Fake Agent",
      id: "fake",
      protocolVersion: "fake-1",
      status,
    },
    taskStream: {
      activate: async () => undefined,
      parseClientFrame: () => undefined,
      submit: async () => taskSnapshot("fake"),
      subscribe: () => () => undefined,
    },
    async attachConversation(input) {
      calls.push({ name: "attach", value: input });
      return { action: "attached", task: taskSnapshot("fake") };
    },
    async createConversation(input) {
      calls.push({ name: "create", value: input });
      return { action: "created", task: taskSnapshot("fake") };
    },
    async listConversations(input) {
      calls.push({ name: "list", value: input });
      return {
        items: [{ native: true }],
        page: { cursor: null, hasMore: false },
      };
    },
    async readConversation(input) {
      calls.push({ name: "read", value: input });
      return {
        items: [{ nativeHistory: true }],
        page: { cursor: null, hasMore: false },
      };
    },
    async forkConversation(input) {
      calls.push({ name: "fork", value: input });
      return { action: "forked", task: taskSnapshot("fake") };
    },
    async archiveConversation(input) {
      calls.push({ name: "archive", value: input });
      if (input.confirm !== true) {
        throw new TaskError(
          "CONFIRMATION_REQUIRED",
          409,
          "Archive requires confirm=true.",
        );
      }
      return { action: "archived", task: null };
    },
    async unarchiveConversation(input) {
      calls.push({ name: "unarchive", value: input });
      return { action: "unarchived", task: null };
    },
    async deleteConversation(input) {
      calls.push({ name: "delete", value: input });
      if (input.confirm !== true) {
        throw new TaskError(
          "CONFIRMATION_REQUIRED",
          409,
          "Delete requires confirm=true.",
        );
      }
      return { action: "deleted", task: null };
    },
  };
}

function taskSnapshot(provider: string): TaskSnapshot {
  return {
    activeTurnId: null,
    createdAt: 1,
    id: "00000000-0000-4000-8000-000000000002",
    initialCwd: "C:\\workspace",
    interruptedAt: null,
    model: null,
    nativeConversationId: null,
    nativeProtocolVersion: "fake-1",
    nativeSessionId: null,
    origin: "pocketpilot",
    permissionMode: null,
    provider,
    sdkSessionId: null,
    state: "idle",
    terminalAt: null,
    updatedAt: 1,
  };
}

function deviceAuthService(): RemoteApiDeviceAuthService {
  const unavailable = (): never => {
    throw new Error("not used");
  };
  return {
    authenticateAccessToken(token) {
      if (token !== "access-token") {
        throw Object.assign(new Error("invalid"), {
          code: "ACCESS_TOKEN_INVALID",
          statusCode: 401,
        });
      }
      return {
        createdAt: 1,
        displayName: "Test device",
        id: deviceId,
        revokedAt: null,
      };
    },
    claimPairingCredentials: unavailable,
    createPairingClaimChallenge: unavailable,
    createRefreshChallenge: unavailable,
    refreshCredentials: unavailable,
    registerPairingDevice: unavailable,
  };
}
