import type { FastifyInstance } from "fastify";

import { createHttpApp } from "../http/create-http-app.js";
import { registerHealthRoute } from "../http/health.js";

/**
 * Builds the remote control listener without binding it.
 *
 * Authentication and the versioned control routes are intentionally not added
 * until the device-authentication layer is available. Local-admin routes must
 * never be registered here.
 */
export async function buildRemoteApiApp(): Promise<FastifyInstance> {
  const app = await createHttpApp({ websocket: true });
  registerHealthRoute(app);
  return app;
}
