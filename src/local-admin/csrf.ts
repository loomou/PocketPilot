import { timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

export const LOCAL_ADMIN_CSRF_HEADER = "x-pocketpilot-csrf-token";

export type LocalAdminCsrfProtection = {
  expectedOrigin(): string;
  token: string;
};

export function isUnsafeHttpMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

export function hasValidLocalAdminCsrfToken(
  request: FastifyRequest,
  protection: LocalAdminCsrfProtection,
): boolean {
  const origin = request.headers.origin;
  const providedToken = request.headers[LOCAL_ADMIN_CSRF_HEADER];

  return (
    origin === protection.expectedOrigin() &&
    typeof providedToken === "string" &&
    constantTimeEquals(providedToken, protection.token)
  );
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
