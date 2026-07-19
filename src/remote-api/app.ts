import fastifySwagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

import {
  type RemoteDeviceAuthRouteService,
  registerRemoteDeviceAuthRoutes,
} from "../auth/remote-routes.js";
import { createHttpApp } from "../http/create-http-app.js";
import { registerHealthRoute } from "../http/health.js";
import type { PocketPilotLogger } from "../logging/logger.js";
import {
  type ProviderRouteDeviceAuthService,
  type ProviderRouteOptions,
  registerProviderRoutes,
} from "./provider-routes.js";
import {
  registerTaskAgentRoutes,
  type TaskAgentRouteOptions,
} from "./task-agent-routes.js";
import {
  registerTaskEventRoutes,
  type TaskEventRouteOptions,
} from "./task-event-routes.js";
import {
  registerTaskRoutes,
  type TaskRouteDeviceAuthService,
  type TaskRouteManager,
} from "./task-routes.js";

export type RemoteApiDeviceAuthService = RemoteDeviceAuthRouteService &
  ProviderRouteDeviceAuthService &
  TaskRouteDeviceAuthService &
  TaskEventRouteOptions["deviceAuthService"] &
  TaskAgentRouteOptions["deviceAuthService"];

export type RemoteApiAppOptions = {
  agentRuntimeManager?: ProviderRouteOptions["agentRuntimeManager"] &
    TaskAgentRouteOptions["agentRuntimeManager"];
  connectionRegistry?: TaskEventRouteOptions["connectionRegistry"] &
    TaskAgentRouteOptions["connectionRegistry"];
  deviceAuthService?: RemoteApiDeviceAuthService;
  eventJournal?: TaskEventRouteOptions["eventJournal"];
  logger?: PocketPilotLogger;
  taskAgentConnectionRegistry?: TaskAgentRouteOptions["taskConnectionRegistry"];
  taskManager?: TaskRouteManager;
};

/**
 * Builds the remote control listener without binding it.
 *
 * Authentication and the versioned control routes are intentionally not added
 * until the device-authentication layer is available. Local-admin routes must
 * never be registered here.
 */
export async function buildRemoteApiApp(
  options: RemoteApiAppOptions = {},
): Promise<FastifyInstance> {
  const app = await createHttpApp({
    listenerKind: "remote",
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    websocket: true,
  });
  await app.register(fastifySwagger, {
    hideUntagged: true,
    openapi: {
      components: {
        securitySchemes: {
          bearerAuth: {
            bearerFormat: "Opaque PocketPilot access credential",
            scheme: "bearer",
            type: "http",
          },
        },
      },
      info: {
        description:
          "Remote mobile control contract for a user-operated PocketPilot Agent.",
        title: "PocketPilot Mobile API",
        version: "1.0.0",
      },
      openapi: "3.1.0",
      servers: [],
      tags: [
        { name: "Authentication" },
        { name: "Providers" },
        { name: "Conversations" },
        { name: "Tasks" },
        { name: "Events" },
        { name: "Agent Stream" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  registerHealthRoute(app);
  if (options.deviceAuthService !== undefined) {
    registerRemoteDeviceAuthRoutes(
      app,
      options.deviceAuthService,
      options.logger,
    );
    if (options.agentRuntimeManager !== undefined) {
      registerProviderRoutes(app, {
        agentRuntimeManager: options.agentRuntimeManager,
        deviceAuthService: options.deviceAuthService,
      });
    }
    if (options.taskManager !== undefined) {
      registerTaskRoutes(app, {
        deviceAuthService: options.deviceAuthService,
        taskManager: options.taskManager,
      });
    }
  }
  if (
    options.connectionRegistry !== undefined &&
    options.deviceAuthService !== undefined &&
    options.eventJournal !== undefined
  ) {
    registerTaskEventRoutes(app, {
      connectionRegistry: options.connectionRegistry,
      deviceAuthService: options.deviceAuthService,
      eventJournal: options.eventJournal,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }
  if (
    options.connectionRegistry !== undefined &&
    options.agentRuntimeManager !== undefined &&
    options.deviceAuthService !== undefined &&
    options.taskAgentConnectionRegistry !== undefined
  ) {
    registerTaskAgentRoutes(app, {
      agentRuntimeManager: options.agentRuntimeManager,
      connectionRegistry: options.connectionRegistry,
      deviceAuthService: options.deviceAuthService,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      taskConnectionRegistry: options.taskAgentConnectionRegistry,
    });
  }
  return app;
}
