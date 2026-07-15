export class RuntimeControlError extends Error {
  public constructor(
    public readonly code:
      | "RUNTIME_CONTROL_REJECTED"
      | "RUNTIME_CONTROL_UNAVAILABLE"
      | "RUNTIME_NOT_RUNNING"
      | "RUNTIME_STATE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeControlError";
  }
}
