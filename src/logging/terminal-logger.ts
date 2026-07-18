import { z } from "zod";

export type TerminalLogOutput = {
  isTTY?: boolean;
  write(chunk: string): unknown;
};

type CreateTerminalLogDestinationOptions = {
  color: boolean;
  now?: () => Date;
  output: TerminalLogOutput;
};

const logValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const terminalLogRecordSchema = z
  .object({
    event: z.string(),
    level: z.number().int(),
    msg: z.string(),
    time: z.union([z.string(), z.number()]),
  })
  .catchall(logValueSchema);

const levelPresentation = {
  20: { color: 36, label: "DEBUG" },
  30: { color: 32, label: "INFO" },
  40: { color: 33, label: "WARN" },
  50: { color: 31, label: "ERROR" },
  60: { color: 31, label: "FATAL" },
} as const;

const identifierPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const metadataIndent = " ".repeat(29);

export function createTerminalLogDestination(
  options: CreateTerminalLogDestinationOptions,
): { write(chunk: string): void } {
  let pending = "";
  return {
    write(chunk): void {
      pending += chunk;
      for (;;) {
        const newlineIndex = pending.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        if (line.length === 0) {
          continue;
        }
        options.output.write(`${formatTerminalLogLine(line, options)}\n`);
      }
    },
  };
}

function formatTerminalLogLine(
  line: string,
  options: CreateTerminalLogDestinationOptions,
): string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return `${formatTimestamp(options.now?.() ?? new Date(), options.color)}  ${colorize("ERROR", 31, options.color)}  Invalid internal log record`;
  }
  const parsed = terminalLogRecordSchema.safeParse(value);
  if (!parsed.success) {
    return `${formatTimestamp(options.now?.() ?? new Date(), options.color)}  ${colorize("ERROR", 31, options.color)}  Invalid internal log record`;
  }

  const presentation =
    levelPresentation[parsed.data.level as keyof typeof levelPresentation] ??
    levelPresentation[30];
  const timestamp = new Date(parsed.data.time);
  const header = `${formatTimestamp(timestamp, options.color)}  ${colorize(presentation.label.padEnd(5), presentation.color, options.color)}  ${parsed.data.msg} ${dim(`[${parsed.data.event}]`, options.color)}`;
  const excluded = new Set(["event", "level", "msg", "time"]);
  const fields = Object.entries(parsed.data).filter(
    ([key]) => !excluded.has(key),
  );
  if (fields.length === 0) {
    return header;
  }
  const metadata = fields.map(
    ([key, fieldValue]) =>
      `${metadataIndent}${dim(`${key}=${formatFieldValue(fieldValue)}`, options.color)}`,
  );
  return [header, ...metadata].join("\n");
}

function formatTimestamp(timestamp: Date, color: boolean): string {
  const value = Number.isNaN(timestamp.getTime())
    ? "0000-00-00 00:00:00"
    : [
        timestamp.getFullYear().toString().padStart(4, "0"),
        "-",
        (timestamp.getMonth() + 1).toString().padStart(2, "0"),
        "-",
        timestamp.getDate().toString().padStart(2, "0"),
        " ",
        timestamp.getHours().toString().padStart(2, "0"),
        ":",
        timestamp.getMinutes().toString().padStart(2, "0"),
        ":",
        timestamp.getSeconds().toString().padStart(2, "0"),
      ].join("");
  return dim(value, color);
}

function formatFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return identifierPattern.test(value)
      ? `${value.slice(0, 8)}...${value.slice(-4)}`
      : value;
  }
  if (value === null) {
    return "null";
  }
  return String(value);
}

function dim(value: string, enabled: boolean): string {
  return enabled ? `\u001b[2m${value}\u001b[0m` : value;
}

function colorize(value: string, color: number, enabled: boolean): string {
  return enabled ? `\u001b[${color}m${value}\u001b[0m` : value;
}
