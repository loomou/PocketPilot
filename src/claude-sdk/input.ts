import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type InputWaiter = (result: IteratorResult<SDKUserMessage>) => void;

/**
 * A single, task-scoped input source for one long-lived SDK Query.
 *
 * Query.streamInput() closes the CLI's stdin when its supplied iterable ends.
 * A task must therefore enqueue every later instruction on this same iterable,
 * instead of calling Query.streamInput() again for each conversation turn.
 */
export class ClaudeSdkInputStream implements AsyncIterable<SDKUserMessage> {
  #closed = false;
  #iterated = false;
  #messages: SDKUserMessage[] = [];
  #waiting: InputWaiter | undefined;

  public close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#waiting?.({ done: true, value: undefined });
    this.#waiting = undefined;
  }

  public push(message: SDKUserMessage): void {
    if (this.#closed) {
      throw new Error(
        "Cannot add an instruction to a closed Claude SDK input stream.",
      );
    }

    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ done: false, value: message });
      return;
    }

    this.#messages.push(message);
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    if (this.#iterated) {
      throw new Error("A Claude SDK input stream can only be consumed once.");
    }

    this.#iterated = true;

    try {
      while (true) {
        const message = this.#messages.shift();
        if (message !== undefined) {
          yield message;
          continue;
        }

        if (this.#closed) {
          return;
        }

        const next = await new Promise<IteratorResult<SDKUserMessage>>(
          (resolve) => {
            this.#waiting = resolve;
          },
        );

        if (next.done) {
          return;
        }

        yield next.value;
      }
    } finally {
      this.#closed = true;
      this.#waiting = undefined;
    }
  }
}

/**
 * Builds a human instruction in the shape expected by the Claude Agent SDK.
 *
 * Task-level validation belongs to the future task runtime. This boundary only
 * translates an already-accepted instruction into the SDK protocol.
 */
export function createSdkUserMessage(instruction: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: instruction,
    },
    parent_tool_use_id: null,
    origin: {
      kind: "human",
    },
  };
}

/** Produces a finite SDK input stream for a single conversation turn. */
export async function* singleTurnInput(
  instruction: string,
): AsyncIterable<SDKUserMessage> {
  yield createSdkUserMessage(instruction);
}
