export type TaskErrorCode =
  | "CONCURRENT_TASK_LIMIT_REACHED"
  | "INVALID_TASK_OPERATION"
  | "STALE_APPROVAL"
  | "TASK_BUSY"
  | "TASK_INTERRUPTED"
  | "TASK_NOT_FOUND"
  | "TASK_SESSION_UNAVAILABLE"
  | "TASK_TERMINAL"
  | "UNSUPPORTED_PERMISSION_MODE"
  | "WORKSPACE_NOT_AUTHORIZED"
  | "WORKSPACE_SCOPE_RISK_NOT_ACCEPTED";

export class TaskError extends Error {
  public constructor(
    public readonly code: TaskErrorCode,
    public readonly statusCode: 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}
