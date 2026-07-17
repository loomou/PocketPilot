import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { registerDeviceAuthErrorHandler } from "../../src/auth/http.js";
import { createHttpApp } from "../../src/http/create-http-app.js";
import { registerSessionRoutes } from "../../src/remote-api/session-routes.js";
import type { TaskSnapshot } from "../../src/tasks/task-types.js";

const deviceId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";

describe("Claude session routes", () => {
  const apps: Array<Awaited<ReturnType<typeof createHttpApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("requires bearer auth and forwards catalog and history parameters", async () => {
    const calls: Array<{ name: string; value: unknown }> = [];
    const app = await createHttpApp();
    registerDeviceAuthErrorHandler(app);
    registerSessionRoutes(app, {
      deviceAuthService: {
        authenticateAccessToken(token) {
          if (token !== "access-token") throw new Error("invalid token");
          return { id: deviceId } as never;
        },
      },
      taskManager: {
        async attachClaudeSession(input) {
          calls.push({ name: "attach", value: input });
          return { action: "attached", task: snapshot(input.sessionId) };
        },
        async createClaudeConversation(input) {
          calls.push({ name: "create", value: input });
          return { action: "created", task: snapshot(null) };
        },
        async listClaudeSessions(input) {
          calls.push({ name: "list", value: input });
          return {
            nextOffset: 12,
            sessions: [
              {
                futureSdkField: true,
                lastModified: 1,
                sessionId,
                summary: "Session",
              },
            ],
          };
        },
        async readClaudeSessionHistory(input) {
          calls.push({ name: "history", value: input });
          return {
            messages: [
              {
                futureSdkField: true,
                message: { content: "hello" },
                parent_agent_id: null,
                parent_tool_use_id: null,
                session_id: sessionId,
                type: "user",
                uuid: "message-1",
              },
            ],
            page: { beforeUuid: null, hasMoreBefore: false },
          };
        },
      },
    });
    await app.ready();
    apps.push(app);

    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/sessions?workspace=C%3A%5Cworkspace",
    });
    expect(unauthorized.statusCode).toBe(401);

    const headers = { authorization: "Bearer access-token" };
    const listed = await app.inject({
      headers,
      method: "GET",
      url: "/v1/sessions?workspace=C%3A%5Cworkspace&limit=6&offset=6",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      nextOffset: 12,
      sessions: [{ futureSdkField: true, sessionId }],
    });

    const history = await app.inject({
      headers,
      method: "GET",
      url: `/v1/sessions/${sessionId}/messages?workspace=C%3A%5Cworkspace&limit=25&beforeUuid=message-50&includeSystemMessages=true`,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      messages: [{ futureSdkField: true, uuid: "message-1" }],
    });

    const operationId = randomUUID();
    await app.inject({
      headers,
      method: "POST",
      payload: {
        operationId,
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: "/v1/sessions",
    });
    await app.inject({
      headers,
      method: "POST",
      payload: {
        operationId: randomUUID(),
        workspace: "C:\\workspace",
        workspaceRiskAccepted: true,
      },
      url: `/v1/sessions/${sessionId}/attach`,
    });

    expect(calls).toEqual([
      {
        name: "list",
        value: { limit: 6, offset: 6, workspace: "C:\\workspace" },
      },
      {
        name: "history",
        value: {
          beforeUuid: "message-50",
          includeSystemMessages: true,
          limit: 25,
          sessionId,
          workspace: "C:\\workspace",
        },
      },
      {
        name: "create",
        value: {
          deviceId,
          operationId,
          workspace: "C:\\workspace",
          workspaceRiskAccepted: true,
        },
      },
      {
        name: "attach",
        value: {
          deviceId,
          operationId: expect.any(String),
          sessionId,
          workspace: "C:\\workspace",
          workspaceRiskAccepted: true,
        },
      },
    ]);
  });
});

function snapshot(sdkSessionId: string | null): TaskSnapshot {
  return {
    createdAt: 1,
    id: randomUUID(),
    initialCwd: "C:\\workspace",
    interruptedAt: null,
    model: null,
    origin: "claude-session",
    permissionMode: null,
    sdkSessionId,
    state: "idle",
    terminalAt: null,
    updatedAt: 1,
  };
}
