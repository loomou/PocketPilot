import type {
  CanUseTool,
  EffortLevel,
  ModelInfo,
  Options,
  PermissionMode,
  Query,
  SDKControlInitializeResponse,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeSdkInputStream } from "./input.js";

export const pinnedPermissionModes: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
];

export const pinnedEffortLevels = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

const effortLevelCoverage: Record<EffortLevel, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

void effortLevelCoverage;

// A newly added SDK permission mode must be considered deliberately before an
// SDK upgrade can compile. The product must expose every installed SDK mode.
const permissionModeCoverage: Record<PermissionMode, true> = {
  default: true,
  acceptEdits: true,
  bypassPermissions: true,
  plan: true,
  dontAsk: true,
  auto: true,
};

void permissionModeCoverage;

const pocketPilotClaudeCodeEntrypoint = "pocketpilot";

export type ClaudeSdkQuery = Pick<
  Query,
  | "applyFlagSettings"
  | "initializationResult"
  | "interrupt"
  | "setModel"
  | "setPermissionMode"
  | "supportedModels"
  | "close"
> &
  AsyncIterable<SDKMessage>;

export type ClaudeSdkQueryFactory = (params: {
  options?: Options;
  prompt: AsyncIterable<SDKUserMessage>;
}) => ClaudeSdkQuery;

export type OpenClaudeSdkSessionOptions = {
  canUseTool?: CanUseTool;
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resume?: string;
};

export type ClaudeSdkInitialization = {
  initialization: SDKControlInitializeResponse;
  models: ModelInfo[];
};

/**
 * Long-lived task-scoped wrapper around a streaming Claude Agent SDK Query.
 * It is deliberately non-persistent: the task runtime will own persisted
 * session IDs and construct this wrapper again with Options.resume after a
 * process restart.
 */
export class ClaudeSdkSession {
  readonly #input: ClaudeSdkInputStream;
  readonly #query: ClaudeSdkQuery;
  #sessionId: string | undefined;

  public constructor(
    queryInstance: ClaudeSdkQuery,
    input: ClaudeSdkInputStream,
  ) {
    this.#query = queryInstance;
    this.#input = input;
  }

  /**
   * The SDK exposes its session ID on emitted messages, not on Query or the
   * initialize control response. It becomes available after the event loop
   * observes the initial system message.
   */
  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  public async initialize(): Promise<ClaudeSdkInitialization> {
    const [initialization, models] = await Promise.all([
      this.#query.initializationResult(),
      this.#query.supportedModels(),
    ]);

    return {
      initialization,
      models,
    };
  }

  public async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
    return this.#query.interrupt();
  }

  public async setModel(model: string | undefined): Promise<void> {
    await this.#query.setModel(model);
  }

  public async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#query.setPermissionMode(mode);
  }

  public async setEffortLevel(effortLevel: EffortLevel | null): Promise<void> {
    // The generated Settings type omits the SDK's session-only `max` effort,
    // although EffortLevel, ModelInfo and the live control protocol support it.
    // Keep that declaration/runtime mismatch isolated at this adapter boundary.
    const settings = { effortLevel } as unknown as Parameters<
      ClaudeSdkQuery["applyFlagSettings"]
    >[0];
    await this.#query.applyFlagSettings(settings);
  }

  /** Adds the next raw SDK user message to the Query's long-lived input. */
  public submit(message: SDKUserMessage): void {
    this.#input.push(message);
  }

  public async supportedModels(): Promise<ModelInfo[]> {
    return this.#query.supportedModels();
  }

  public close(): void {
    this.#input.close();
    this.#query.close();
  }

  public async *events(): AsyncGenerator<SDKMessage> {
    for await (const message of this.#query) {
      if (message.session_id !== undefined) {
        this.#sessionId = message.session_id;
      }
      yield message;
    }
  }
}

export function openClaudeSdkSession(
  options: OpenClaudeSdkSessionOptions,
  createQuery: ClaudeSdkQueryFactory = query,
): ClaudeSdkSession {
  const input = new ClaudeSdkInputStream();
  const queryOptions: Options = {
    cwd: options.cwd,
    includePartialMessages: true,
    ...(options.resume === undefined
      ? {
          env: {
            ...process.env,
            CLAUDE_CODE_ENTRYPOINT: pocketPilotClaudeCodeEntrypoint,
          },
        }
      : {}),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.permissionMode === undefined
      ? {}
      : { permissionMode: options.permissionMode }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.canUseTool === undefined
      ? {}
      : { canUseTool: options.canUseTool }),
  };

  return new ClaudeSdkSession(
    createQuery({
      prompt: input,
      options: queryOptions,
    }),
    input,
  );
}
