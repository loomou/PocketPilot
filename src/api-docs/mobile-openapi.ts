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

type WebSocketExtension = {
  "x-websocket": {
    authentication: {
      scheme: "bearerAuth";
      stage: "handshake";
    };
    clientMessages: {
      subscribe: object;
    };
    closeCodes: Record<string, string>;
    notes: readonly string[];
    serverMessages: {
      error: object;
      event: object;
      subscribed: object;
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
    addWebSocketExtension(document);
    return document;
  } finally {
    await app.close();
  }
}

function addWebSocketExtension(document: MobileOpenApiDocument): void {
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
        "afterCursor replays retained active-turn events before live delivery.",
        "A mobile disconnect never pauses or cancels task work.",
        "Swagger UI displays this contract but does not execute WebSocket messages.",
      ],
      serverMessages: {
        error: z.toJSONSchema(eventErrorMessageSchema),
        event: z.toJSONSchema(eventDeliveryMessageSchema),
        subscribed: z.toJSONSchema(eventSubscribedMessageSchema),
      },
    },
  };
  document.paths["/v1/events"] = { ...path, get: extendedOperation };
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

const documentationTaskManager: TaskRouteManager = {
  closeTask: unavailableDocumentationHandler,
  createTask: unavailableDocumentationHandler,
  getTask: unavailableDocumentationHandler,
  interruptTask: unavailableDocumentationHandler,
  listTasks: unavailableDocumentationHandler,
  resolveApproval: unavailableDocumentationHandler,
  resumeTask: unavailableDocumentationHandler,
  setModel: unavailableDocumentationHandler,
  setPermissionMode: unavailableDocumentationHandler,
  submitInstruction: unavailableDocumentationHandler,
  supportedPermissionModes: unavailableDocumentationHandler,
};

const documentationDependencies = {
  connectionRegistry: {
    add: unavailableDocumentationHandler,
    closeDeviceConnections: unavailableDocumentationHandler,
  },
  deviceAuthService: documentationDeviceAuthService,
  eventJournal: {
    subscribe: unavailableDocumentationHandler,
  },
  taskManager: documentationTaskManager,
};
