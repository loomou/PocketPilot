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
  readonly input: Record<string, unknown>;
  readonly options: SerializableCanUseToolOptions;
  readonly toolName: string;
  cancel(message?: string): void;
  resolve(result: PermissionResult): void;
};

type ApprovalRequest = Parameters<CanUseTool>[2];
export type SerializableCanUseToolOptions = Omit<ApprovalRequest, "signal">;

export type SerializableCanUseToolRequest = {
  input: Parameters<CanUseTool>[1];
  options: SerializableCanUseToolOptions;
  toolName: Parameters<CanUseTool>[0];
};

class PendingToolApprovalImpl implements PendingToolApproval {
  readonly #decision = createDeferred<PermissionResult>();
  #settled = false;

  public readonly input: Record<string, unknown>;
  public readonly options: SerializableCanUseToolOptions;
  public readonly toolName: string;

  public constructor(
    toolName: string,
    input: Record<string, unknown>,
    options: ApprovalRequest,
  ) {
    this.toolName = toolName;
    this.input = input;
    const { signal: _signal, ...serializableOptions } = options;
    this.options = serializableOptions;
  }

  public cancel(message = "Tool approval was cancelled."): void {
    this.reject(new ToolApprovalCancelledError(message));
  }

  public resolve(result: PermissionResult): void {
    this.settle(result);
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

  private settle(result: PermissionResult): void {
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
