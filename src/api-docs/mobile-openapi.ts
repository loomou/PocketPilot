import type { OpenAPI, OpenAPIV3 } from "openapi-types";
import { z } from "zod";

import {
  buildRemoteApiApp,
  type RemoteApiDeviceAuthService,
} from "../remote-api/app.js";
import {
  eventDeliveryMessageSchema,
  eventErrorMessageSchema,
  eventSubscribedMessageSchema,
  eventSubscriptionMessageSchema,
  taskEventRouteDocumentation,
} from "../remote-api/task-event-routes.js";
import type { TaskRouteManager } from "../remote-api/task-routes.js";
import {
  sdkUserMessageTransportSchema,
  sdkWebSocketClose,
  type TaskSdkRouteOptions,
  taskSdkRouteDocumentation,
} from "../remote-api/task-sdk-routes.js";

type WebSocketExtension = {
  "x-websocket": {
    authentication: {
      scheme: "bearerAuth";
      stage: "handshake";
    };
    clientMessages: {
      [name: string]: object;
    };
    closeCodes: Record<string, string>;
    notes: readonly string[];
    serverMessages: {
      [name: string]: object;
    };
  };
};

export type MobileOpenApiDocument = OpenAPIV3.Document;

/** Generates the complete mobile contract without storage, listeners, or SDK work. */
export async function buildMobileOpenApiDocument(): Promise<MobileOpenApiDocument> {
  const app = await buildRemoteApiApp(documentationDependencies);
  try {
    await app.ready();
    const document = app.swagger();
    if (!isOpenApi31Document(document)) {
      throw new Error("The generated mobile API document is not OpenAPI 3.1.");
    }
    addWebSocketExtensions(document);
    return document;
  } finally {
    await app.close();
  }
}

function addWebSocketExtensions(document: MobileOpenApiDocument): void {
  addControlWebSocketExtension(document);
  addSdkWebSocketExtension(document);
}

function addControlWebSocketExtension(document: MobileOpenApiDocument): void {
  const path = document.paths["/v1/events"];
  const operation = path?.get ?? {
    ...taskEventRouteDocumentation,
    responses: {
      101: { description: "WebSocket protocol switch accepted." },
    },
  };

  const extendedOperation: OpenAPIV3.OperationObject<WebSocketExtension> = {
    ...operation,
    "x-websocket": {
      authentication: { scheme: "bearerAuth", stage: "handshake" },
      clientMessages: {
        subscribe: z.toJSONSchema(eventSubscriptionMessageSchema),
      },
      closeCodes: {
        "4003": "Authentication failed or the paired device was revoked.",
      },
      notes: [
        "This stream carries PocketPilot control events only and never carries Claude SDK conversation messages.",
        "afterCursor replays retained active-turn control events before live delivery.",
        "A mobile disconnect never pauses or cancels task work.",
        "Swagger UI displays this contract but does not execute WebSocket messages.",
      ],
      serverMessages: {
        approvalRequested: approvalRequestedControlEventSchema,
        error: z.toJSONSchema(eventErrorMessageSchema),
        event: z.toJSONSchema(eventDeliveryMessageSchema),
        subscribed: z.toJSONSchema(eventSubscribedMessageSchema),
      },
    },
  };
  document.paths["/v1/events"] = { ...path, get: extendedOperation };
}

const approvalRequestedControlEventSchema = {
  additionalProperties: false,
  description:
    "PocketPilot control envelope carrying every serializable CanUseTool callback argument. AbortSignal remains local.",
  properties: {
    event: {
      additionalProperties: false,
      properties: {
        kind: { const: "approval.requested" },
        payload: {
          additionalProperties: false,
          properties: {
            input: { additionalProperties: true, type: "object" },
            options: {
              additionalProperties: true,
              properties: {
                agentID: { type: "string" },
                blockedPath: { type: "string" },
                decisionReason: { type: "string" },
                description: { type: "string" },
                displayName: { type: "string" },
                requestId: { type: "string" },
                suggestions: { items: {}, type: "array" },
                title: { type: "string" },
                toolUseID: { type: "string" },
              },
              required: ["toolUseID", "requestId"],
              type: "object",
            },
            toolName: { type: "string" },
          },
          required: ["toolName", "input", "options"],
          type: "object",
        },
      },
      required: ["kind", "payload"],
      type: "object",
    },
  },
  required: ["event"],
  type: "object",
};

function addSdkWebSocketExtension(document: MobileOpenApiDocument): void {
  const route = "/v1/tasks/{taskId}/sdk";
  const path = document.paths[route];
  const operation = path?.get ?? {
    ...taskSdkRouteDocumentation,
    responses: {
      101: { description: "WebSocket protocol switch accepted." },
    },
  };
  const sdkMessageSchema = {
    additionalProperties: true,
    description:
      "Raw SDKMessage JSON object. The installed SDK package is the source of truth for all variants and fields.",
    properties: { type: { type: "string" } },
    required: ["type"],
    type: "object",
  };
  const sdkUserMessageSchema = z.toJSONSchema(sdkUserMessageTransportSchema);

  const extendedOperation: OpenAPIV3.OperationObject<WebSocketExtension> = {
    ...operation,
    "x-websocket": {
      authentication: { scheme: "bearerAuth", stage: "handshake" },
      clientMessages: { sdkUserMessage: sdkUserMessageSchema },
      closeCodes: Object.fromEntries(
        Object.values(sdkWebSocketClose).map(({ code, reason }) => [
          String(code),
          reason,
        ]),
      ),
      notes: [
        "Wire types are owned by @anthropic-ai/claude-agent-sdk@0.3.210.",
        "Client frames are raw SDKUserMessage objects and server frames are raw SDKMessage objects with no PocketPilot wrapper.",
        "afterUuid resumes after a retained SDK UUID; a missing or unknown value replays the current active turn from its beginning.",
        "Swagger UI displays this contract but does not execute WebSocket messages.",
      ],
      serverMessages: { sdkMessage: sdkMessageSchema },
    },
  };
  document.paths[route] = { ...path, get: extendedOperation };
}

function isOpenApi31Document(
  document: OpenAPI.Document,
): document is OpenAPIV3.Document {
  return "openapi" in document && document.openapi === "3.1.0";
}

const unavailableDocumentationHandler = (): never => {
  throw new Error("Documentation-only route handlers must never execute.");
};

const documentationDeviceAuthService: RemoteApiDeviceAuthService = {
  authenticateAccessToken: unavailableDocumentationHandler,
  claimPairingCredentials: unavailableDocumentationHandler,
  createPairingClaimChallenge: unavailableDocumentationHandler,
  createRefreshChallenge: unavailableDocumentationHandler,
  refreshCredentials: unavailableDocumentationHandler,
  registerPairingDevice: unavailableDocumentationHandler,
};

const documentationTaskManager: TaskRouteManager &
  TaskSdkRouteOptions["taskManager"] = {
  authorizedWorkspaceRoots: unavailableDocumentationHandler,
  closeTask: unavailableDocumentationHandler,
  createTask: unavailableDocumentationHandler,
  getTask: unavailableDocumentationHandler,
  interruptTask: unavailableDocumentationHandler,
  listTasks: unavailableDocumentationHandler,
  resolveApproval: unavailableDocumentationHandler,
  resumeTask: unavailableDocumentationHandler,
  setModel: unavailableDocumentationHandler,
  setPermissionMode: unavailableDocumentationHandler,
  submitSdkMessage: unavailableDocumentationHandler,
  supportedPermissionModes: unavailableDocumentationHandler,
};

const documentationDependencies = {
  connectionRegistry: {
    add: unavailableDocumentationHandler,
    closeDeviceConnections: unavailableDocumentationHandler,
  },
  deviceAuthService: documentationDeviceAuthService,
  eventJournal: {
    subscribeControl: unavailableDocumentationHandler,
    subscribeSdk: unavailableDocumentationHandler,
  },
  taskManager: documentationTaskManager,
};
