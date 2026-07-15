export class BootstrapCommandUnavailableError extends Error {
  public readonly exitCode = 2;

  public constructor(commandName: string) {
    super(
      `agent ${commandName} is unavailable until the secure runtime is implemented.`,
    );
    this.name = "BootstrapCommandUnavailableError";
  }
}

export function requireRuntimeImplementation(commandName: string): never {
  throw new BootstrapCommandUnavailableError(commandName);
}
