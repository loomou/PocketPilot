import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type InputWaiter = (result: IteratorResult<SDKUserMessage>) => void;

/**
 * A single, task-scoped input source for one long-lived SDK Query.
 *
 * Query.streamInput() closes the CLI's stdin when its supplied iterable ends.
 * A task must therefore enqueue every later SDK user message on this iterable,
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
        "Cannot add a message to a closed Claude SDK input stream.",
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
