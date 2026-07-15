import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

export class ToolApprovalCancelledError extends Error {
  public constructor(message = "Tool approval was cancelled.") {
    super(message);
    this.name = "ToolApprovalCancelledError";
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

export type PendingToolApproval = {
  readonly blockedPath: string | undefined;
  readonly description: string | undefined;
  readonly displayName: string | undefined;
  readonly input: Record<string, unknown>;
  readonly requestId: string;
  readonly suggestions: Parameters<CanUseTool>[2]["suggestions"];
  readonly title: string | undefined;
  readonly toolName: string;
  readonly toolUseId: string;
  approve(
    result?: Omit<Extract<PermissionResult, { behavior: "allow" }>, "behavior">,
  ): void;
  cancel(message?: string): void;
  deny(message: string, interrupt?: boolean): void;
};

type ApprovalRequest = Parameters<CanUseTool>[2];

class PendingToolApprovalImpl implements PendingToolApproval {
  readonly #decision = createDeferred<PermissionResult>();
  #settled = false;

  public readonly blockedPath: string | undefined;
  public readonly description: string | undefined;
  public readonly displayName: string | undefined;
  public readonly input: Record<string, unknown>;
  public readonly requestId: string;
  public readonly suggestions: ApprovalRequest["suggestions"];
  public readonly title: string | undefined;
  public readonly toolName: string;
  public readonly toolUseId: string;

  public constructor(
    toolName: string,
    input: Record<string, unknown>,
    options: ApprovalRequest,
  ) {
    this.toolName = toolName;
    this.input = input;
    this.requestId = options.requestId;
    this.toolUseId = options.toolUseID;
    this.suggestions = options.suggestions;
    this.blockedPath = options.blockedPath;
    this.title = options.title;
    this.displayName = options.displayName;
    this.description = options.description;
  }

  public approve(
    result: Omit<
      Extract<PermissionResult, { behavior: "allow" }>,
      "behavior"
    > = {},
  ): void {
    this.resolve({ behavior: "allow", ...result });
  }

  public cancel(message = "Tool approval was cancelled."): void {
    this.reject(new ToolApprovalCancelledError(message));
  }

  public deny(message: string, interrupt?: boolean): void {
    this.resolve({
      behavior: "deny",
      message,
      ...(interrupt === undefined ? {} : { interrupt }),
    });
  }

  public waitForDecision(signal: AbortSignal): Promise<PermissionResult> {
    if (signal.aborted) {
      this.cancel("The Claude SDK aborted the tool approval.");
      return this.#decision.promise;
    }

    const onAbort = (): void => {
      this.cancel("The Claude SDK aborted the tool approval.");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    return this.#decision.promise.finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  }

  private reject(reason: Error): void {
    if (this.#settled) {
      return;
    }

    this.#settled = true;
    this.#decision.reject(reason);
  }

  private resolve(result: PermissionResult): void {
    if (this.#settled) {
      return;
    }

    this.#settled = true;
    this.#decision.resolve(result);
  }
}

export type ToolApprovalObserver = (approval: PendingToolApproval) => void;

/**
 * Converts SDK tool permission callbacks into task-owned, cancellable pending
 * approvals. The future task runtime owns registration, mobile delivery, and
 * cancellation on interrupt, close, and shutdown.
 */
export function createToolApprovalHandler(
  onPendingApproval: ToolApprovalObserver,
): CanUseTool {
  return async (toolName, input, options) => {
    const approval = new PendingToolApprovalImpl(toolName, input, options);
    onPendingApproval(approval);
    return approval.waitForDecision(options.signal);
  };
}
