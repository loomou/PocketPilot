import { TaskError } from "./errors.js";

type PendingOperation = {
  generation: number;
  operation: (lease: TaskOperationLease) => Promise<unknown> | unknown;
  reject(error: unknown): void;
  resolve(value: unknown): void;
};

export class TaskOperationLease {
  public constructor(
    private readonly scheduler: TaskOperationScheduler,
    private readonly generation: number,
  ) {}

  public assertCurrent(): void {
    if (!this.scheduler.isCurrent(this.generation)) {
      throw taskOperationSupersededError();
    }
  }
}

/** FIFO P2 scheduler whose pending work can be invalidated by P0/P1. */
export class TaskOperationScheduler {
  readonly #pending: PendingOperation[] = [];
  #activeGeneration: number | undefined;
  #generation = 0;

  public run<T>(
    operation: (lease: TaskOperationLease) => Promise<T> | T,
  ): Promise<T> {
    const generation = this.#generation;
    return new Promise<T>((resolve, reject) => {
      this.#pending.push({
        generation,
        operation,
        reject,
        resolve: (value) => resolve(value as T),
      });
      this.pump();
    });
  }

  public invalidate(): void {
    this.#generation += 1;
    for (const operation of this.#pending.splice(0)) {
      operation.reject(taskOperationSupersededError());
    }
  }

  public isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  private pump(): void {
    if (this.#activeGeneration === this.#generation) {
      return;
    }
    const pending = this.#pending.shift();
    if (pending === undefined) {
      return;
    }
    if (!this.isCurrent(pending.generation)) {
      pending.reject(taskOperationSupersededError());
      this.pump();
      return;
    }

    this.#activeGeneration = pending.generation;
    const lease = new TaskOperationLease(this, pending.generation);
    void Promise.resolve()
      .then(() => {
        lease.assertCurrent();
        return pending.operation(lease);
      })
      .then(
        (value) => {
          try {
            lease.assertCurrent();
            pending.resolve(value);
          } catch (error) {
            pending.reject(error);
          }
        },
        (error: unknown) => pending.reject(error),
      )
      .finally(() => {
        if (this.#activeGeneration === pending.generation) {
          this.#activeGeneration = undefined;
        }
        this.pump();
      });
  }
}

export function taskOperationSupersededError(): TaskError {
  return new TaskError(
    "TASK_OPERATION_SUPERSEDED",
    409,
    "A higher-priority task operation superseded this request.",
  );
}
