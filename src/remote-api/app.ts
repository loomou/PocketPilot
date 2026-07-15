import type { FastifyInstance } from "fastify";

import type { DeviceAuthService } from "../auth/device-auth-service.js";
import { registerRemoteDeviceAuthRoutes } from "../auth/remote-routes.js";
import { createHttpApp } from "../http/create-http-app.js";
import { registerHealthRoute } from "../http/health.js";

export type RemoteApiAppOptions = {
  deviceAuthService?: DeviceAuthService;
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
  return app;
}
