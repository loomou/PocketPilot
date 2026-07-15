import type {
  CanUseTool,
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

import {
  type NormalizedClaudeSdkEvent,
  normalizeSdkMessage,
} from "./event-normalizer.js";
import { ClaudeSdkInputStream } from "./input.js";

export const pinnedPermissionModes: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
];

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

export type ClaudeSdkQuery = Pick<
  Query,
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

  /** Adds the next instruction to the Query's one long-lived input stream. */
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

  public async *events(): AsyncGenerator<NormalizedClaudeSdkEvent> {
    for await (const message of this.#query) {
      this.#sessionId = message.session_id;
      const event = normalizeSdkMessage(message);
      if (event !== undefined) {
        yield event;
      }
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
