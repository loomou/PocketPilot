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

export class AgentMaintenanceError extends Error {
  public constructor(
    public readonly code:
      | "AGENT_DATA_NOT_FOUND"
      | "AGENT_MAINTENANCE_LOCK_UNAVAILABLE"
      | "AGENT_MAINTENANCE_LOCKED"
      | "MASTER_KEYS_IDENTICAL",
    message: string,
  ) {
    super(message);
    this.name = "AgentMaintenanceError";
  }
}
