import fastifySwagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

import {
  type RemoteDeviceAuthRouteService,
  registerRemoteDeviceAuthRoutes,
} from "../auth/remote-routes.js";
import { createHttpApp } from "../http/create-http-app.js";
import { registerHealthRoute } from "../http/health.js";
import {
  registerTaskEventRoutes,
  type TaskEventRouteOptions,
} from "./task-event-routes.js";
import {
  registerTaskRoutes,
  type TaskRouteDeviceAuthService,
  type TaskRouteManager,
} from "./task-routes.js";
import {
  registerTaskSdkRoutes,
  type TaskSdkRouteOptions,
} from "./task-sdk-routes.js";

export type RemoteApiDeviceAuthService = RemoteDeviceAuthRouteService &
  TaskRouteDeviceAuthService &
  TaskEventRouteOptions["deviceAuthService"] &
  TaskSdkRouteOptions["deviceAuthService"];

export type RemoteApiAppOptions = {
  connectionRegistry?: TaskEventRouteOptions["connectionRegistry"] &
    TaskSdkRouteOptions["connectionRegistry"];
  deviceAuthService?: RemoteApiDeviceAuthService;
  eventJournal?: TaskEventRouteOptions["eventJournal"] &
    TaskSdkRouteOptions["eventJournal"];
  taskManager?: TaskRouteManager & TaskSdkRouteOptions["taskManager"];
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
  const app = await createHttpApp({ websocket: true });
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
        { name: "Tasks" },
        { name: "Events" },
        { name: "SDK" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  registerHealthRoute(app);
  if (options.deviceAuthService !== undefined) {
    registerRemoteDeviceAuthRoutes(app, options.deviceAuthService);
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
    });
  }
  if (
    options.connectionRegistry !== undefined &&
    options.deviceAuthService !== undefined &&
    options.eventJournal !== undefined &&
    options.taskManager !== undefined
  ) {
    registerTaskSdkRoutes(app, {
      connectionRegistry: options.connectionRegistry,
      deviceAuthService: options.deviceAuthService,
      eventJournal: options.eventJournal,
      taskManager: options.taskManager,
    });
  }
  return app;
}
