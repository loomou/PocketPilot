import { describe, expect, it } from "vitest";

import { logEvents } from "../../src/logging/events.js";
import {
  createPocketPilotLogger,
  safeErrorFields,
} from "../../src/logging/logger.js";

describe("PocketPilot logger", () => {
  it("formats readable aligned records and abbreviates opaque identifiers", () => {
    const capture = createCapture();
    const logger = createPocketPilotLogger({
      color: false,
      destination: capture,
      level: "info",
    });

    logger.info(logEvents.pairingApproved, "Pairing approved", {
      deviceId: "00000000-0000-4000-8000-000000000002",
      pairingId: "00000000-0000-4000-8000-000000000001",
    });

    expect(capture.value()).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} {2}INFO {3}Pairing approved \[pairing\.approved\]/,
    );
    expect(capture.value()).toContain("deviceId=00000000...0002");
    expect(capture.value()).toContain("pairingId=00000000...0001");
  });

  it("uses colors only when enabled and supports level filtering", () => {
    const capture = createCapture();
    const logger = createPocketPilotLogger({
      color: true,
      destination: capture,
      level: "info",
    });

    logger.debug(logEvents.httpRequestCompleted, "HTTP request completed");
    logger.warn(logEvents.authRequestRejected, "Authentication rejected", {
      code: "ACCESS_TOKEN_INVALID",
    });

    expect(capture.value()).not.toContain("HTTP request completed");
    expect(capture.value()).toContain("\u001b[33mWARN");
    expect(capture.value()).toContain("Authentication rejected");
  });

  it("omits forbidden fields and normalizes control characters", () => {
    const capture = createCapture();
    const logger = createPocketPilotLogger({
      color: false,
      destination: capture,
      level: "debug",
    });

    logger.info(logEvents.pairingClaimCompleted, "Claim\ncompleted", {
      accessToken: "must-not-appear",
      authorization: "Bearer must-not-appear",
      code: "PAIRING_NOT_APPROVED",
      content: "sensitive prompt",
      verificationCode: "123456",
    });

    expect(capture.value()).toContain("Claim completed");
    expect(capture.value()).toContain("code=PAIRING_NOT_APPROVED");
    for (const forbidden of [
      "must-not-appear",
      "sensitive prompt",
      "123456",
      "accessToken",
      "authorization",
      "verificationCode",
    ]) {
      expect(capture.value()).not.toContain(forbidden);
    }
  });

  it("disables colors for non-TTY output and NO_COLOR", () => {
    const redirected = createCapture();
    createPocketPilotLogger({
      destination: redirected,
      environment: {},
      level: "info",
    }).info(logEvents.runtimeStarted, "Runtime started");

    const noColor = createCapture(true);
    createPocketPilotLogger({
      destination: noColor,
      environment: { NO_COLOR: "1" },
      level: "info",
    }).info(logEvents.runtimeStarted, "Runtime started");

    expect(redirected.value()).not.toContain("\u001b[");
    expect(noColor.value()).not.toContain("\u001b[");
  });

  it("accepts only stable error identifiers", () => {
    expect(
      safeErrorFields({
        code: "PAIRING_NOT_APPROVED",
        name: "DeviceAuthError",
      }),
    ).toEqual({
      errorCode: "PAIRING_NOT_APPROVED",
      errorType: "DeviceAuthError",
    });
    expect(
      safeErrorFields({
        code: "secret value",
        name: "Error: sensitive prompt",
      }),
    ).toEqual({ errorType: "UnknownError" });
  });
});

function createCapture(isTTY = false): {
  isTTY: boolean;
  value(): string;
  write(chunk: string): void;
} {
  let output = "";
  return {
    isTTY,
    value: () => output,
    write(chunk): void {
      output += chunk;
    },
  };
}
