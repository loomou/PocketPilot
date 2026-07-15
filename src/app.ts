import type { FastifyInstance } from "fastify";
import { buildRemoteApiApp } from "./remote-api/app.js";

/**
 * Creates the HTTP application without binding a network listener.
 *
 * The runtime layer owns the remote and local-admin listener sockets.
 */
export async function buildApp(): Promise<FastifyInstance> {
  return buildRemoteApiApp();
}
