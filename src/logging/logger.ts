import pino, { type DestinationStream, type Logger } from "pino";

import type { PocketPilotLogLevel } from "../config/environment.js";
import type { LogEvent } from "./events.js";
import {
  createTerminalLogDestination,
  type TerminalLogOutput,
} from "./terminal-logger.js";

export type SafeLogValue = boolean | null | number | string;
export type SafeLogFields = Readonly<Record<string, SafeLogValue | undefined>>;

export type PocketPilotLogger = {
  child(fields: SafeLogFields): PocketPilotLogger;
  debug(event: LogEvent, title: string, fields?: SafeLogFields): void;
  error(event: LogEvent, title: string, fields?: SafeLogFields): void;
  info(event: LogEvent, title: string, fields?: SafeLogFields): void;
  warn(event: LogEvent, title: string, fields?: SafeLogFields): void;
};

export type CreatePocketPilotLoggerOptions = {
  color?: boolean;
  destination?: TerminalLogOutput;
  environment?: NodeJS.ProcessEnv;
  level: PocketPilotLogLevel;
  now?: () => Date;
};

const forbiddenFieldFragments = [
  "accesstoken",
  "apikey",
  "authorization",
  "content",
  "credential",
  "csrftoken",
  "environment",
  "input",
  "masterkey",
  "message",
  "output",
  "payload",
  "prompt",
  "proof",
  "refreshtoken",
  "secret",
  "settings",
  "signature",
  "token",
  "toolinput",
  "tooloutput",
  "verificationcode",
] as const;

const reservedFieldNames = new Set(["event", "level", "msg", "pid", "time"]);
const pinoRedactionPaths = [
  "accessToken",
  "apiKey",
  "authorization",
  "content",
  "credential",
  "csrfToken",
  "devicePublicKey",
  "environment",
  "input",
  "masterKey",
  "message",
  "newMasterKey",
  "output",
  "payload",
  "prompt",
  "proof",
  "refreshToken",
  "settings",
  "shutdownControlToken",
  "signature",
  "token",
  "toolInput",
  "toolOutput",
  "verificationCode",
] as const;
const maximumFieldLength = 512;
const safeErrorCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const safeErrorTypePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export const noopLogger: PocketPilotLogger = {
  child: () => noopLogger,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

export function createPocketPilotLogger(
  options: CreatePocketPilotLoggerOptions,
): PocketPilotLogger {
  const destination = options.destination ?? process.stderr;
  const environment = options.environment ?? process.env;
  const color =
    options.color ??
    (destination.isTTY === true && environment.NO_COLOR === undefined);
  const terminalDestination = createTerminalLogDestination({
    color,
    output: destination,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const baseLogger = pino(
    {
      base: null,
      level: options.level,
      redact: { paths: [...pinoRedactionPaths], remove: true },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    terminalDestination as DestinationStream,
  );
  return new PinoPocketPilotLogger(baseLogger, {});
}

export function safeErrorFields(error: unknown): SafeLogFields {
  if (typeof error !== "object" || error === null) {
    return { errorType: typeof error };
  }
  const errorType =
    "name" in error &&
    typeof error.name === "string" &&
    safeErrorTypePattern.test(error.name)
      ? error.name
      : "UnknownError";
  const fields: Record<string, SafeLogValue> = {
    errorType,
  };
  if (
    "code" in error &&
    typeof error.code === "string" &&
    safeErrorCodePattern.test(error.code)
  ) {
    fields.errorCode = error.code;
  }
  return fields;
}

class PinoPocketPilotLogger implements PocketPilotLogger {
  public constructor(
    private readonly logger: Logger,
    private readonly context: SafeLogFields,
  ) {}

  public child(fields: SafeLogFields): PocketPilotLogger {
    return new PinoPocketPilotLogger(this.logger, {
      ...this.context,
      ...sanitizeFields(fields),
    });
  }

  public debug(
    event: LogEvent,
    title: string,
    fields: SafeLogFields = {},
  ): void {
    this.write("debug", event, title, fields);
  }

  public error(
    event: LogEvent,
    title: string,
    fields: SafeLogFields = {},
  ): void {
    this.write("error", event, title, fields);
  }

  public info(
    event: LogEvent,
    title: string,
    fields: SafeLogFields = {},
  ): void {
    this.write("info", event, title, fields);
  }

  public warn(
    event: LogEvent,
    title: string,
    fields: SafeLogFields = {},
  ): void {
    this.write("warn", event, title, fields);
  }

  private write(
    level: PocketPilotLogLevel,
    event: LogEvent,
    title: string,
    fields: SafeLogFields,
  ): void {
    this.logger[level](
      {
        ...sanitizeFields(this.context),
        ...sanitizeFields(fields),
        event,
      },
      sanitizeString(title),
    );
  }
}

function sanitizeFields(fields: SafeLogFields): Record<string, SafeLogValue> {
  const safe: Record<string, SafeLogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      value === undefined ||
      reservedFieldNames.has(key) ||
      isForbiddenFieldName(key)
    ) {
      continue;
    }
    safe[key] = typeof value === "string" ? sanitizeString(value) : value;
  }
  return safe;
}

function isForbiddenFieldName(name: string): boolean {
  const normalized = name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return forbiddenFieldFragments.some((fragment) =>
    normalized.includes(fragment),
  );
}

function sanitizeString(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  return sanitized.length <= maximumFieldLength
    ? sanitized
    : `${sanitized.slice(0, maximumFieldLength - 3)}...`;
}
