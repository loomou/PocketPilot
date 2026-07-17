import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildMobileOpenApiDocument } from "../../src/api-docs/mobile-openapi.js";
import {
  eventDeliveryMessageSchema,
  eventErrorMessageSchema,
  eventSubscribedMessageSchema,
  eventSubscriptionMessageSchema,
} from "../../src/remote-api/task-event-routes.js";

const expectedPaths = [
  "/v1/auth/refresh",
  "/v1/auth/refresh-challenge/{deviceId}",
  "/v1/auth/session",
  "/v1/capabilities",
  "/v1/events",
  "/v1/pair/{pairingId}/claim",
  "/v1/pair/{pairingId}/claim-challenge",
  "/v1/pair/{pairingId}/register",
  "/v1/sessions",
  "/v1/sessions/{sessionId}/attach",
  "/v1/sessions/{sessionId}/messages",
  "/v1/tasks",
  "/v1/tasks/{taskId}",
  "/v1/tasks/{taskId}/approvals/{requestId}",
  "/v1/tasks/{taskId}/close",
  "/v1/tasks/{taskId}/composer-options",
  "/v1/tasks/{taskId}/effort",
  "/v1/tasks/{taskId}/interrupt",
  "/v1/tasks/{taskId}/model",
  "/v1/tasks/{taskId}/permission-mode",
  "/v1/tasks/{taskId}/resume",
  "/v1/tasks/{taskId}/sdk",
  "/v1/workspaces",
] as const;

const websocketExtensionSchema = z.object({
  "x-websocket": z.object({
    authentication: z.object({
      scheme: z.literal("bearerAuth"),
      stage: z.literal("handshake"),
    }),
    clientMessages: z.record(z.string(), z.object({})),
    closeCodes: z.record(z.string(), z.string().min(1)),
    notes: z.array(z.string().min(1)).min(1),
    serverMessages: z.record(z.string(), z.object({})),
  }),
});

describe("mobile OpenAPI generation", () => {
  it("generates a deterministic remote-only OpenAPI 3.1 contract", async () => {
    const first = await buildMobileOpenApiDocument();
    const second = await buildMobileOpenApiDocument();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.openapi).toBe("3.1.0");
    expect(Object.keys(first.paths).sort()).toEqual(expectedPaths);
    expect(first.components?.securitySchemes).toHaveProperty("bearerAuth");

    const operations = Object.entries(first.paths).flatMap(([path, pathItem]) =>
      (["get", "post"] as const).flatMap((method) => {
        const operation = pathItem?.[method];
        return operation === undefined ? [] : [{ operation, path }];
      }),
    );
    const operationIds = operations.map(
      ({ operation }) => operation.operationId,
    );
    expect(operationIds.every((operationId) => operationId !== undefined)).toBe(
      true,
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const unauthenticatedPaths = new Set([
      "/v1/auth/refresh",
      "/v1/auth/refresh-challenge/{deviceId}",
      "/v1/pair/{pairingId}/claim",
      "/v1/pair/{pairingId}/claim-challenge",
      "/v1/pair/{pairingId}/register",
    ]);
    for (const { operation, path } of operations) {
      if (unauthenticatedPaths.has(path)) {
        expect(operation.security).toBeUndefined();
      } else {
        expect(operation.security).toEqual([{ bearerAuth: [] }]);
      }
    }

    const serialized = JSON.stringify(first);
    for (const forbidden of [
      "/admin/",
      "/_internal/",
      "AGENT_MASTER_KEY",
      "ANTHROPIC_API_KEY",
      "runtime-control-token",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    const approvalOperation =
      first.paths["/v1/tasks/{taskId}/approvals/{requestId}"]?.post;
    const approvalSerialized = JSON.stringify(approvalOperation);
    for (const field of [
      "result",
      "updatedInput",
      "updatedPermissions",
      "toolUseID",
      "decisionClassification",
      "message",
      "interrupt",
    ]) {
      expect(approvalSerialized).toContain(field);
    }
  });

  it("documents WebSocket messages from the runtime Zod contracts", async () => {
    const document = await buildMobileOpenApiDocument();
    const controlOperation = document.paths["/v1/events"]?.get;
    const parsed = websocketExtensionSchema.parse(controlOperation);

    expect(parsed["x-websocket"].notes.join(" ")).toContain("afterCursor");
    expect(parsed["x-websocket"].notes.join(" ")).toContain(
      "control events only",
    );
    expect(parsed["x-websocket"].serverMessages).not.toHaveProperty(
      "sdkMessage",
    );
    expect(parsed["x-websocket"].serverMessages).toHaveProperty(
      "approvalRequested",
    );
    const controlSerialized = JSON.stringify(controlOperation);
    for (const field of [
      "suggestions",
      "blockedPath",
      "decisionReason",
      "title",
      "displayName",
      "description",
      "toolUseID",
      "agentID",
      "requestId",
    ]) {
      expect(controlSerialized).toContain(field);
    }

    const sdkOperation = document.paths["/v1/tasks/{taskId}/sdk"]?.get;
    const sdk = websocketExtensionSchema.parse(sdkOperation)["x-websocket"];
    expect(sdk.clientMessages).toHaveProperty("sdkUserMessage");
    expect(sdk.serverMessages).toHaveProperty("sdkMessage");
    expect(sdk.closeCodes).toEqual({
      "4000": "SDK_MESSAGE_INVALID",
      "4003": "AUTHENTICATION_FAILED",
      "4004": "TASK_NOT_FOUND",
      "4009": "TASK_SESSION_UNAVAILABLE",
      "4011": "SDK_TRANSPORT_FAILED",
    });
    expect(sdk.notes.join(" ")).toContain(
      "@anthropic-ai/claude-agent-sdk@0.3.210",
    );
    expect(sdk.notes.join(" ")).toContain("no PocketPilot wrapper");
    expect(sdk.notes.join(" ")).toContain("afterUuid");
    expect(sdk.notes.join(" ")).toContain("before activating");
    const historyOperation =
      document.paths["/v1/sessions/{sessionId}/messages"]?.get;
    const historySerialized = JSON.stringify(historyOperation);
    for (const contract of [
      "beforeUuid",
      "hasMoreBefore",
      "HISTORY_CURSOR_STALE",
      "includeSystemMessages",
      "@anthropic-ai/claude-agent-sdk@0.3.210",
    ]) {
      expect(historySerialized).toContain(contract);
    }
    expect(
      eventSubscriptionMessageSchema.safeParse({
        afterCursor: 3,
        taskId: "00000000-0000-4000-8000-000000000001",
        type: "subscribe",
      }).success,
    ).toBe(true);
    expect(
      eventSubscribedMessageSchema.safeParse({
        afterCursor: 3,
        taskId: "00000000-0000-4000-8000-000000000001",
        type: "subscribed",
      }).success,
    ).toBe(true);
    expect(
      eventDeliveryMessageSchema.safeParse({
        event: {
          cursor: 4,
          event: { kind: "task.state", payload: { state: "idle" } },
          occurredAt: 1,
          taskId: "00000000-0000-4000-8000-000000000001",
        },
        type: "event",
      }).success,
    ).toBe(true);
    expect(
      eventErrorMessageSchema.safeParse({
        code: "EVENT_SUBSCRIPTION_INVALID",
        type: "error",
      }).success,
    ).toBe(true);
    expect(
      eventSubscriptionMessageSchema.safeParse({ type: "subscribe" }).success,
    ).toBe(false);
  });
});
