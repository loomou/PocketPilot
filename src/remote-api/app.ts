import type { FastifyInstance } from "fastify";

import type { DeviceAuthService } from "../auth/device-auth-service.js";
import type { InMemoryDeviceConnectionRegistry } from "../auth/device-connection-registry.js";
import { registerRemoteDeviceAuthRoutes } from "../auth/remote-routes.js";
import { createHttpApp } from "../http/create-http-app.js";
import { registerHealthRoute } from "../http/health.js";
import type { TaskEventJournal } from "../tasks/task-event-journal.js";
import { registerTaskEventRoutes } from "./task-event-routes.js";

export type RemoteApiAppOptions = {
  connectionRegistry?: InMemoryDeviceConnectionRegistry;
  deviceAuthService?: DeviceAuthService;
  eventJournal?: TaskEventJournal;
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
  registerHealthRoute(app);
  if (options.deviceAuthService !== undefined) {
    registerRemoteDeviceAuthRoutes(app, options.deviceAuthService);
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
  return app;
}
