export type LocalAdminErrorCode =
  | "AUTHORIZED_DIRECTORY_INVALID"
  | "AUTHORIZED_DIRECTORY_NOT_FOUND"
  | "AUTHORIZED_DIRECTORY_SNAPSHOT_STALE"
  | "DIRECTORY_PICKER_BUSY"
  | "DIRECTORY_PICKER_UNAVAILABLE"
  | "DIRECTORY_SELECTION_UNAVAILABLE"
  | "VOLUME_ROOT_RISK_NOT_ACCEPTED";

export class LocalAdminError extends Error {
  public constructor(
    public readonly code: LocalAdminErrorCode,
    public readonly statusCode: 409 | 422 | 503,
    message: string,
  ) {
    super(message);
    this.name = "LocalAdminError";
  }
}
