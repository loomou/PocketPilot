import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

import { logEvents } from "../logging/events.js";
import {
  noopLogger,
  type PocketPilotLogger,
  safeErrorFields,
} from "../logging/logger.js";
import type {
  CodexBridgeDelivery,
  CodexClientRequestFrame,
  CodexInitializeInfo,
  CodexJsonObject,
  CodexRequestId,
} from "./types.js";
import { isCodexJsonObject, isCodexRequestId } from "./types.js";

const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_PROTOCOL_VERSION = "0.144";

type CodexProcess = Pick<
  ChildProcessWithoutNullStreams,
  "kill" | "pid" | "stderr" | "stdin" | "stdout"
> &
  EventEmitter & {
    terminateTree?: () => Promise<void>;
  };

export type CodexProcessFactory = (input: {
  args: readonly string[];
  command: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}) => CodexProcess;

type PendingRequest = {
  clientRequestId?: CodexRequestId;
  ownerTaskId?: string;
  reject?: (error: Error) => void;
  resolve?: (value: unknown) => void;
  timer: NodeJS.Timeout;
};

export class CodexAppServerError extends Error {
  public constructor(
    public readonly code:
      | "CODEX_APP_SERVER_EXITED"
      | "CODEX_APP_SERVER_FRAME_INVALID"
      | "CODEX_APP_SERVER_NOT_RUNNING"
      | "CODEX_APP_SERVER_REQUEST_FAILED"
      | "CODEX_APP_SERVER_REQUEST_TIMEOUT"
      | "CODEX_APP_SERVER_VERSION_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

export type CodexAppServerBridgeOptions = {
  command?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  logger?: PocketPilotLogger;
  maxFrameBytes?: number;
  processFactory?: CodexProcessFactory;
  requestTimeoutMs?: number;
};

/** Owns one initialized Codex App Server stdio JSONL connection. */
export class CodexAppServerBridge {
  readonly #command: string;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #listeners = new Set<(delivery: CodexBridgeDelivery) => void>();
  readonly #logger: PocketPilotLogger;
  readonly #maxFrameBytes: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #processFactory: CodexProcessFactory;
  readonly #requestTimeoutMs: number;
  #closed = false;
  #initializeInfo: CodexInitializeInfo | undefined;
  #nextRequestId = 1;
  #process: CodexProcess | undefined;
  #startPromise: Promise<CodexInitializeInfo> | undefined;
  #stdoutBuffer = "";
  #writeLane = Promise.resolve();
  #connectionGeneration = 0;

  public constructor(options: CodexAppServerBridgeOptions = {}) {
    this.#command = options.command ?? "codex";
    this.#cwd = options.cwd ?? process.cwd();
    this.#environment = options.environment ?? process.env;
    this.#logger = options.logger ?? noopLogger;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#processFactory = options.processFactory ?? defaultProcessFactory;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  public get initializeInfo(): CodexInitializeInfo | undefined {
    return this.#initializeInfo;
  }

  /** Changes whenever a new native process connection is initialized. */
  public get connectionGeneration(): number {
    return this.#connectionGeneration;
  }

  public start(): Promise<CodexInitializeInfo> {
    if (this.#closed) {
      return Promise.reject(
        new CodexAppServerError(
          "CODEX_APP_SERVER_NOT_RUNNING",
          "The Codex App Server bridge is closed.",
        ),
      );
    }
    this.#startPromise ??= this.startProcess().catch((error: unknown) => {
      if (this.#process !== undefined) {
        this.onProcessFailure(
          error instanceof Error
            ? error
            : new CodexAppServerError(
                "CODEX_APP_SERVER_EXITED",
                "The Codex App Server process failed.",
              ),
        );
      }
      throw error;
    });
    return this.#startPromise;
  }

  public subscribe(
    listener: (delivery: CodexBridgeDelivery) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async request(method: string, params: unknown): Promise<unknown> {
    await this.start();
    return this.sendRequest(method, params);
  }

  public async forward(
    taskId: string,
    frame: CodexClientRequestFrame,
  ): Promise<void> {
    await this.start();
    const wireRequestId = this.nextRequestId("remote");
    const key = requestKey(wireRequestId);
    if (this.#pending.has(key)) {
      throw new CodexAppServerError(
        "CODEX_APP_SERVER_REQUEST_FAILED",
        "The Codex App Server request id is already pending.",
      );
    }
    const timer = setTimeout(() => {
      this.#pending.delete(key);
      this.emit({
        frame: {
          error: {
            code: -32_000,
            message: "The Codex App Server request timed out.",
          },
          id: frame.id,
        },
        taskId,
      });
    }, this.#requestTimeoutMs);
    timer.unref();
    this.#pending.set(key, {
      clientRequestId: frame.id,
      ownerTaskId: taskId,
      timer,
    });
    try {
      await this.writeFrame({ ...frame, id: wireRequestId });
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(key);
      throw error;
    }
  }

  public async respond(id: CodexRequestId, result: unknown): Promise<void> {
    await this.start();
    await this.writeFrame({ id, result });
  }

  public async rejectServerRequest(
    id: CodexRequestId,
    message: string,
  ): Promise<void> {
    await this.start();
    await this.writeFrame({ error: { code: -32_601, message }, id });
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.rejectAll(
      new CodexAppServerError(
        "CODEX_APP_SERVER_EXITED",
        "The Codex App Server bridge was closed.",
      ),
    );
    const child = this.#process;
    this.#process = undefined;
    if (child === undefined) {
      return;
    }
    child.stdin.end();
    const closePromise = once(child, "close").catch(() => undefined);
    await terminateProcess(child);
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  private async startProcess(): Promise<CodexInitializeInfo> {
    const child = this.#processFactory({
      args: ["app-server", "--listen", "stdio://"],
      command: this.#command,
      cwd: this.#cwd,
      environment: this.#environment,
    });
    this.#process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.#process === child) {
        this.onStdout(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#logger.debug(
        logEvents.codexAppServerStderr,
        "Codex App Server wrote diagnostic output",
        { byteLength: Buffer.byteLength(chunk) },
      );
    });
    child.on("error", (error: Error) => {
      if (this.#process === child) {
        this.onProcessFailure(error, child);
      }
    });
    child.on("close", (code: number | null) => {
      if (!this.#closed && this.#process === child) {
        this.onProcessFailure(
          new CodexAppServerError(
            "CODEX_APP_SERVER_EXITED",
            `The Codex App Server exited unexpectedly (${code ?? "signal"}).`,
          ),
          child,
        );
      }
    });

    const result = await this.sendRequestWithoutStart("initialize", {
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
      clientInfo: {
        name: "codex_cli_rs",
        title: "PocketPilot",
        version: "0.1.0",
      },
    });
    const info = parseInitializeInfo(result);
    if (!isSupportedCodexVersion(info.cliVersion)) {
      throw new CodexAppServerError(
        "CODEX_APP_SERVER_VERSION_UNSUPPORTED",
        "The installed Codex App Server protocol version has not been reviewed.",
      );
    }
    await this.writeFrame({ method: "initialized" });
    this.#initializeInfo = info;
    this.#connectionGeneration += 1;
    this.#logger.info(
      logEvents.codexAppServerStarted,
      "Codex App Server initialized",
      { cliVersion: info.cliVersion },
    );
    return info;
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return this.sendRequestWithoutStart(method, params);
  }

  private sendRequestWithoutStart(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = this.nextRequestId("internal");
    const key = requestKey(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(
          new CodexAppServerError(
            "CODEX_APP_SERVER_REQUEST_TIMEOUT",
            `The Codex App Server did not answer '${method}' in time.`,
          ),
        );
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(key, { reject, resolve, timer });
      void this.writeFrame({ id, method, params }).catch((error: unknown) => {
        clearTimeout(timer);
        this.#pending.delete(key);
        reject(error);
      });
    });
  }

  private writeFrame(frame: CodexJsonObject): Promise<void> {
    const child = this.#process;
    if (child === undefined || this.#closed) {
      return Promise.reject(
        new CodexAppServerError(
          "CODEX_APP_SERVER_NOT_RUNNING",
          "The Codex App Server process is not running.",
        ),
      );
    }
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.#maxFrameBytes) {
      return Promise.reject(
        new CodexAppServerError(
          "CODEX_APP_SERVER_FRAME_INVALID",
          "The Codex App Server frame exceeds the transport limit.",
        ),
      );
    }
    const write = this.#writeLane.then(
      () =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(line, (error) => {
            if (error === null || error === undefined) {
              resolve();
              return;
            }
            reject(error);
          });
        }),
    );
    this.#writeLane = write.catch(() => undefined);
    return write;
  }

  private onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > this.#maxFrameBytes) {
      this.onProcessFailure(
        new CodexAppServerError(
          "CODEX_APP_SERVER_FRAME_INVALID",
          "The Codex App Server emitted an oversized JSONL frame.",
        ),
      );
      return;
    }
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.onProcessFailure(
        new CodexAppServerError(
          "CODEX_APP_SERVER_FRAME_INVALID",
          "The Codex App Server emitted invalid JSON.",
        ),
      );
      return;
    }
    if (!isCodexJsonObject(frame)) {
      this.onProcessFailure(
        new CodexAppServerError(
          "CODEX_APP_SERVER_FRAME_INVALID",
          "The Codex App Server emitted a non-object frame.",
        ),
      );
      return;
    }

    if (isCodexRequestId(frame.id) && ("result" in frame || "error" in frame)) {
      this.onResponse(frame.id, frame);
      return;
    }
    if (typeof frame.method === "string") {
      this.emit({ frame });
      return;
    }
    this.onProcessFailure(
      new CodexAppServerError(
        "CODEX_APP_SERVER_FRAME_INVALID",
        "The Codex App Server emitted an unsupported frame shape.",
      ),
    );
  }

  private onResponse(id: CodexRequestId, frame: CodexJsonObject): void {
    const pending = this.#pending.get(requestKey(id));
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(requestKey(id));
    clearTimeout(pending.timer);
    if (pending.ownerTaskId !== undefined) {
      this.emit({
        frame:
          pending.clientRequestId === undefined
            ? frame
            : { ...frame, id: pending.clientRequestId },
        taskId: pending.ownerTaskId,
      });
      return;
    }
    if ("error" in frame) {
      const detail =
        typeof frame.error === "object" &&
        frame.error !== null &&
        "message" in frame.error &&
        typeof frame.error.message === "string" &&
        frame.error.message.length > 0
          ? frame.error.message
          : undefined;
      pending.reject?.(
        new CodexAppServerError(
          "CODEX_APP_SERVER_REQUEST_FAILED",
          detail === undefined
            ? "The Codex App Server rejected a request."
            : `The Codex App Server rejected a request: ${detail}`,
        ),
      );
      return;
    }
    pending.resolve?.(frame.result);
  }

  private emit(delivery: CodexBridgeDelivery): void {
    for (const listener of this.#listeners) {
      listener(delivery);
    }
  }

  private onProcessFailure(error: Error, failedProcess?: CodexProcess): void {
    if (failedProcess !== undefined && this.#process !== failedProcess) {
      return;
    }
    this.#logger.error(
      logEvents.codexAppServerExited,
      "Codex App Server connection failed",
      safeErrorFields(error),
    );
    const child = this.#process;
    this.#process = undefined;
    this.#startPromise = undefined;
    this.#initializeInfo = undefined;
    this.#stdoutBuffer = "";
    this.rejectAll(
      error instanceof CodexAppServerError
        ? error
        : new CodexAppServerError(
            "CODEX_APP_SERVER_EXITED",
            "The Codex App Server process failed.",
          ),
    );
    if (child !== undefined) {
      void terminateProcess(child);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      if (
        pending.ownerTaskId !== undefined &&
        pending.clientRequestId !== undefined
      ) {
        this.emit({
          frame: {
            error: { code: -32_000, message: error.message },
            id: pending.clientRequestId,
          },
          taskId: pending.ownerTaskId,
        });
      }
      pending.reject?.(error);
    }
    this.#pending.clear();
  }

  private nextRequestId(scope: "internal" | "remote"): string {
    return `pocketpilot:${scope}:${this.#nextRequestId++}`;
  }
}

function defaultProcessFactory(input: {
  args: readonly string[];
  command: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}): CodexProcess {
  const launch = resolveCodexLaunch(input);
  const child = spawn(launch.command, launch.args, {
    cwd: input.cwd,
    env: input.environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: /(?:^|[\\/])cmd\.exe$/iu.test(launch.command),
    windowsHide: true,
  });
  const managedChild = child as CodexProcess;
  managedChild.terminateTree = () => terminateWindowsProcessTree(child);
  return managedChild;
}

function resolveCodexLaunch(input: {
  args: readonly string[];
  command: string;
  environment: NodeJS.ProcessEnv;
}): { args: string[]; command: string } {
  if (process.platform !== "win32") {
    return { args: [...input.args], command: input.command };
  }

  const command =
    resolveWindowsCommand(input.command, input.environment) ?? input.command;
  const extension = extname(command).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const commandLine = `"${quoteWindowsCommandArgument(command)} ${input.args.join(" ")}"`;
    return {
      args: ["/d", "/s", "/c", commandLine],
      command: input.environment.ComSpec ?? "cmd.exe",
    };
  }
  if (extension === ".ps1") {
    return {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        ...input.args,
      ],
      command: "powershell.exe",
    };
  }
  return { args: [...input.args], command };
}

function resolveWindowsCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const extensions = windowsExecutableExtensions(environment);
  const hasDirectory = isAbsolute(command) || /[\\/]/u.test(command);
  const directories = hasDirectory
    ? [""]
    : (readWindowsEnvironmentValue(environment, "PATH")
        ?.split(delimiter)
        .map((entry) => entry.replace(/^"|"$/gu, "")) ?? []);
  const candidates = extname(command).length > 0 ? [""] : extensions;

  for (const directory of directories) {
    for (const extension of candidates) {
      const candidate =
        directory.length === 0
          ? `${command}${extension}`
          : join(directory, `${command}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function isCodexCommandAvailable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (process.platform === "win32") {
    return resolveWindowsCommand(command, environment) !== undefined;
  }
  if (isAbsolute(command) || /[\\/]/u.test(command)) {
    return existsSync(command);
  }
  const path = readWindowsEnvironmentValue(environment, "PATH");
  return (
    path
      ?.split(delimiter)
      .some((directory) => existsSync(join(directory, command))) ?? false
  );
}

function windowsExecutableExtensions(environment: NodeJS.ProcessEnv): string[] {
  const configured = readWindowsEnvironmentValue(environment, "PATHEXT");
  const configuredExtensions = (configured ?? "")
    .split(";")
    .filter((extension) => extension.length > 0)
    .map((extension) =>
      (extension.startsWith(".") ? extension : `.${extension}`).toUpperCase(),
    );
  return [
    ".EXE",
    ".COM",
    ".CMD",
    ".BAT",
    ".PS1",
    ...configuredExtensions,
  ].filter(
    (extension, index, extensions) => extensions.indexOf(extension) === index,
  );
}

function readWindowsEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const entry = Object.entries(environment).find(
    ([key]) => key.toUpperCase() === name,
  );
  return entry?.[1];
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function terminateProcess(child: CodexProcess): Promise<void> {
  if (child.terminateTree !== undefined) {
    await child.terminateTree();
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may already have exited between stdin closure and kill.
  }
}

async function terminateWindowsProcessTree(
  child: Pick<CodexProcess, "kill" | "pid">,
): Promise<void> {
  if (process.platform !== "win32" || child.pid === undefined) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
    return;
  }

  try {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await Promise.race([
      once(killer, "close").then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }
}

function requestKey(id: CodexRequestId): string {
  return `${typeof id}:${id}`;
}

function parseInitializeInfo(value: unknown): CodexInitializeInfo {
  if (
    !isCodexJsonObject(value) ||
    typeof value.userAgent !== "string" ||
    typeof value.platformFamily !== "string" ||
    typeof value.platformOs !== "string"
  ) {
    throw new CodexAppServerError(
      "CODEX_APP_SERVER_FRAME_INVALID",
      "The Codex App Server initialize response is invalid.",
    );
  }
  const version = /\/(\d+\.\d+\.\d+)(?:\s|$)/u.exec(value.userAgent)?.[1];
  if (version === undefined) {
    throw new CodexAppServerError(
      "CODEX_APP_SERVER_FRAME_INVALID",
      "The Codex App Server did not report its CLI version.",
    );
  }
  return {
    cliVersion: version,
    platformFamily: value.platformFamily,
    platformOs: value.platformOs,
    userAgent: value.userAgent,
  };
}

export function isSupportedCodexVersion(version: string): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  return major === 0 && minor === 144 && Number.isInteger(patch);
}

export const codexAppServerProtocolVersion = `codex-app-server@${CODEX_PROTOCOL_VERSION}`;

export type CodexReadinessSnapshot = {
  protocolVersion?: string;
  reasonCode?: string;
  status: "available" | "not_installed" | "unhealthy" | "unsupported_version";
};

const DEFAULT_CODEX_READINESS_PROBE_TIMEOUT_MS = 8_000;

/**
 * Bounded Codex readiness probe used by discovery. Never returns install
 * paths, env dumps, raw stderr, or credentials.
 */
export async function probeCodexReadiness(options: {
  command: string;
  createBridge?: () => CodexAppServerBridge;
  environment?: NodeJS.ProcessEnv;
  existingBridge?: CodexAppServerBridge;
  probeTimeoutMs?: number;
}): Promise<CodexReadinessSnapshot> {
  const environment = options.environment ?? process.env;
  const existingInfo = options.existingBridge?.initializeInfo;
  if (existingInfo !== undefined) {
    if (isSupportedCodexVersion(existingInfo.cliVersion)) {
      return {
        protocolVersion: codexAppServerProtocolVersion,
        status: "available",
      };
    }
    return {
      reasonCode: "CODEX_APP_SERVER_VERSION_UNSUPPORTED",
      status: "unsupported_version",
    };
  }

  if (!isCodexCommandAvailable(options.command, environment)) {
    return {
      reasonCode: "CODEX_COMMAND_NOT_FOUND",
      status: "not_installed",
    };
  }

  // Short-lived probe path. Always close the bridge we create here so a
  // timeout/failure cannot leave an App Server child running.
  const probeTimeoutMs =
    options.probeTimeoutMs ?? DEFAULT_CODEX_READINESS_PROBE_TIMEOUT_MS;
  const bridge =
    options.createBridge?.() ??
    new CodexAppServerBridge({
      command: options.command,
      environment,
      requestTimeoutMs: probeTimeoutMs,
    });
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = await Promise.race([
      bridge.start(),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(
            new CodexAppServerError(
              "CODEX_APP_SERVER_REQUEST_TIMEOUT",
              "Codex readiness probe timed out.",
            ),
          );
        }, probeTimeoutMs);
      }),
    ]);
    if (!isSupportedCodexVersion(info.cliVersion)) {
      return {
        reasonCode: "CODEX_APP_SERVER_VERSION_UNSUPPORTED",
        status: "unsupported_version",
      };
    }
    return {
      protocolVersion: codexAppServerProtocolVersion,
      status: "available",
    };
  } catch (error) {
    if (
      error instanceof CodexAppServerError &&
      error.code === "CODEX_APP_SERVER_VERSION_UNSUPPORTED"
    ) {
      return {
        reasonCode: "CODEX_APP_SERVER_VERSION_UNSUPPORTED",
        status: "unsupported_version",
      };
    }
    if (
      timedOut ||
      (error instanceof CodexAppServerError &&
        error.code === "CODEX_APP_SERVER_REQUEST_TIMEOUT")
    ) {
      return {
        reasonCode: "CODEX_APP_SERVER_PROBE_FAILED",
        status: "unhealthy",
      };
    }
    return {
      reasonCode: "CODEX_APP_SERVER_PROBE_FAILED",
      status: "unhealthy",
    };
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    await bridge.close().catch(() => undefined);
  }
}
