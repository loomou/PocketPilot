import type { OpenAPI, OpenAPIV3 } from "openapi-types";
import { z } from "zod";

import { sdkUserMessageTransportSchema } from "../claude-sdk/transport.js";
import {
  buildRemoteApiApp,
  type RemoteApiAppOptions,
  type RemoteApiDeviceAuthService,
} from "../remote-api/app.js";
import {
  agentWebSocketClose,
  taskAgentRouteDocumentation,
} from "../remote-api/task-agent-routes.js";
import {
  eventDeliveryMessageSchema,
  eventErrorMessageSchema,
  eventSubscribedMessageSchema,
  eventSubscriptionMessageSchema,
  taskEventRouteDocumentation,
} from "../remote-api/task-event-routes.js";

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
  addAgentWebSocketExtension(document);
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

function addAgentWebSocketExtension(document: MobileOpenApiDocument): void {
  const route = "/v1/tasks/{taskId}/agent";
  const path = document.paths[route];
  const operation = path?.get ?? {
    ...taskAgentRouteDocumentation,
    responses: {
      101: { description: "WebSocket protocol switch accepted." },
    },
  };
  const nativeMessageSchema = {
    additionalProperties: true,
    description:
      "Provider-native message JSON object. The selected provider protocol is the source of truth for variants and fields.",
    properties: {
      error: { type: "object" },
      id: { oneOf: [{ type: "integer" }, { type: "string" }] },
      method: { type: "string" },
      params: { type: "object" },
      result: {},
      type: { type: "string" },
    },
    type: "object",
  };
  const sdkUserMessageSchema = z.toJSONSchema(sdkUserMessageTransportSchema);
  const codexJsonRpcFrameSchema = {
    additionalProperties: true,
    description:
      "Codex App Server JSON-RPC request or response. Method, params, result, and error remain Codex-native.",
    properties: {
      error: { type: "object" },
      id: { oneOf: [{ type: "integer" }, { type: "string" }] },
      method: { type: "string" },
      params: { type: "object" },
      result: {},
    },
    type: "object",
  };

  const extendedOperation: OpenAPIV3.OperationObject<WebSocketExtension> = {
    ...operation,
    "x-websocket": {
      authentication: { scheme: "bearerAuth", stage: "handshake" },
      clientMessages: {
        claudeSdkUserMessage: sdkUserMessageSchema,
        codexJsonRpcFrame: codexJsonRpcFrameSchema,
      },
      closeCodes: Object.fromEntries(
        Object.values(agentWebSocketClose).map(({ code, reason }) => [
          String(code),
          reason,
        ]),
      ),
      notes: [
        "Read task.provider and task.nativeProtocolVersion before opening this stream and select the matching provider codec.",
        "Client and server frames are provider-native objects with no PocketPilot wrapper.",
        "For Claude, wire types are owned by @anthropic-ai/claude-agent-sdk@0.3.210 and remain raw SDKUserMessage/SDKMessage objects.",
        "For a session-centric runtime, PocketPilot installs this raw subscriber before activating the new or resumed Query so the original system/init message is delivered unchanged.",
        "History uses the separate SDK SessionMessage API; clients virtualize, prepend older pages, and deduplicate history/live rows by SDK UUID where available.",
        "The optional afterCursor query is interpreted by the selected provider; for Claude it contains an SDK UUID, while Codex uses PocketPilot's out-of-band native-frame cursor. A missing or unknown value replays the retained window from its beginning.",
        "Swagger UI displays this contract but does not execute WebSocket messages.",
      ],
      serverMessages: { providerNativeMessage: nativeMessageSchema },
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

const documentationTaskManager: NonNullable<
  RemoteApiAppOptions["taskManager"]
> = {
  authorizedWorkspaceRoots: unavailableDocumentationHandler,
  closeTask: unavailableDocumentationHandler,
  createTask: unavailableDocumentationHandler,
  getComposerOptions: unavailableDocumentationHandler,
  getTask: unavailableDocumentationHandler,
  interruptTask: unavailableDocumentationHandler,
  listTasks: unavailableDocumentationHandler,
  resolveApproval: unavailableDocumentationHandler,
  resumeTask: unavailableDocumentationHandler,
  setModel: unavailableDocumentationHandler,
  setEffortLevel: unavailableDocumentationHandler,
  setPermissionMode: unavailableDocumentationHandler,
  supportedPermissionModes: unavailableDocumentationHandler,
};

const documentationAgentRuntimeManager: NonNullable<
  RemoteApiAppOptions["agentRuntimeManager"]
> = {
  attachConversation: unavailableDocumentationHandler,
  createConversation: unavailableDocumentationHandler,
  listConversations: unavailableDocumentationHandler,
  listProviders: unavailableDocumentationHandler,
  providerCapabilities: unavailableDocumentationHandler,
  readConversation: unavailableDocumentationHandler,
  task: unavailableDocumentationHandler,
  taskProvider: unavailableDocumentationHandler,
};

const documentationDependencies = {
  agentRuntimeManager: documentationAgentRuntimeManager,
  connectionRegistry: {
    add: unavailableDocumentationHandler,
    closeDeviceConnections: unavailableDocumentationHandler,
  },
  deviceAuthService: documentationDeviceAuthService,
  eventJournal: {
    subscribeControl: unavailableDocumentationHandler,
  },
  taskAgentConnectionRegistry: {
    add: unavailableDocumentationHandler,
  },
  taskManager: documentationTaskManager,
};
