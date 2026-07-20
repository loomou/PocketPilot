export type TaskAgentWebSocket = {
  close(code?: number, data?: string): void;
};

export const taskAgentSessionUnavailableClose = {
  code: 4_009,
  reason: "TASK_SESSION_UNAVAILABLE",
} as const;

/** Tracks provider-native task sockets separately from the control socket. */
export class InMemoryTaskAgentConnectionRegistry {
  readonly #connections = new Map<string, Set<TaskAgentWebSocket>>();

  public add(taskId: string, socket: TaskAgentWebSocket): () => void {
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
        taskAgentSessionUnavailableClose.code,
        taskAgentSessionUnavailableClose.reason,
      );
    }
  }

  private remove(taskId: string, socket: TaskAgentWebSocket): void {
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
