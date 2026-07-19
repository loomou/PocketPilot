export type AgentProviderErrorCode =
  | "AGENT_PROVIDER_NOT_FOUND"
  | "AGENT_PROVIDER_UNAVAILABLE";

export class AgentProviderError extends Error {
  public constructor(
    public readonly code: AgentProviderErrorCode,
    public readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "AgentProviderError";
  }
}
