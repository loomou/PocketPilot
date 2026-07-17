export type TaskSdkWebSocket = {
  close(code?: number, data?: string): void;
};

export const taskSdkSessionUnavailableClose = {
  code: 4_009,
  reason: "TASK_SESSION_UNAVAILABLE",
} as const;

/** Tracks raw SDK sockets separately so task P0 does not close control sockets. */
export class InMemoryTaskSdkConnectionRegistry {
  readonly #connections = new Map<string, Set<TaskSdkWebSocket>>();

  public add(taskId: string, socket: TaskSdkWebSocket): () => void {
    const taskConnections = this.#connections.get(taskId) ?? new Set();
    taskConnections.add(socket);
    this.#connections.set(taskId, taskConnections);
    return () => this.remove(taskId, socket);
  }

  public closeTaskConnections(taskId: string): void {
    const taskConnections = this.#connections.get(taskId);
    if (taskConnections === undefined) {
      return;
    }
    this.#connections.delete(taskId);
    for (const socket of taskConnections) {
      socket.close(
        taskSdkSessionUnavailableClose.code,
        taskSdkSessionUnavailableClose.reason,
      );
    }
  }

  private remove(taskId: string, socket: TaskSdkWebSocket): void {
    const taskConnections = this.#connections.get(taskId);
    if (taskConnections === undefined) {
      return;
    }
    taskConnections.delete(socket);
    if (taskConnections.size === 0) {
      this.#connections.delete(taskId);
    }
  }
}
