export type DeviceAuthErrorCode =
  | "ACCESS_TOKEN_EXPIRED"
  | "ACCESS_TOKEN_INVALID"
  | "ACCESS_TOKEN_REVOKED"
  | "CHALLENGE_ALREADY_USED"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_NOT_FOUND"
  | "DEVICE_PROOF_INVALID"
  | "DEVICE_PUBLIC_KEY_INVALID"
  | "DEVICE_REVOKED"
  | "DEVICE_NOT_FOUND"
  | "MOBILE_BASE_URL_NOT_CONFIGURED"
  | "PAIRING_ALREADY_USED"
  | "PAIRING_EXPIRED"
  | "PAIRING_NOT_APPROVED"
  | "PAIRING_NOT_FOUND"
  | "PAIRING_NOT_PENDING"
  | "PAIRING_VERIFICATION_CODE_MISMATCH"
  | "REFRESH_TOKEN_EXPIRED"
  | "REFRESH_TOKEN_INVALID"
  | "REFRESH_TOKEN_REUSED";

export class DeviceAuthError extends Error {
  public constructor(
    public readonly code: DeviceAuthErrorCode,
    public readonly statusCode: 401 | 404 | 409 | 410,
    message: string,
  ) {
    super(message);
    this.name = "DeviceAuthError";
  }
}
