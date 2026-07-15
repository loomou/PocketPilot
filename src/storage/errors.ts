export class StorageCryptoError extends Error {
  public constructor(
    public readonly code: "AUTHENTICATION_FAILED" | "INVALID_ENVELOPE",
    message: string,
  ) {
    super(message);
    this.name = "StorageCryptoError";
  }
}

export class StorageDataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StorageDataError";
  }
}

export class MasterKeyError extends Error {
  public constructor(
    public readonly code: "MASTER_KEY_INVALID" | "MASTER_KEY_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "MasterKeyError";
  }
}

export class StorageResetConfirmationError extends Error {
  public constructor() {
    super("Resetting Agent-managed data requires explicit confirmation.");
    this.name = "StorageResetConfirmationError";
  }
}
