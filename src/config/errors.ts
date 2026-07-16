export class EnvironmentConfigurationError extends Error {
  public constructor(
    public readonly code: "DOTENV_READ_FAILED" | "ENVIRONMENT_VALUE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentConfigurationError";
  }
}
