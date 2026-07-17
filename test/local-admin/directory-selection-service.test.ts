import { describe, expect, it } from "vitest";

import { DirectorySelectionService } from "../../src/local-admin/directory-selection-service.js";
import type {
  DirectoryPicker,
  DirectoryPickerResult,
} from "../../src/local-admin/windows-directory-picker.js";

describe("DirectorySelectionService", () => {
  it("returns cancellation without creating a selection", async () => {
    const service = createService({ status: "cancelled" });
    await expect(service.pick()).resolves.toEqual({ status: "cancelled" });
  });

  it("canonicalizes a selection and consumes it once", async () => {
    const service = createService(
      { path: "C:\\picked", status: "selected" },
      { canonicalPath: "C:\\Canonical" },
    );
    const result = await service.pick();
    expect(result).toMatchObject({
      path: "C:\\Canonical",
      status: "selected",
      volumeRoot: false,
    });
    if (result.status !== "selected") {
      throw new Error("Expected a selected directory.");
    }

    expect(service.consume(result.selectionId)).toMatchObject({
      path: "C:\\Canonical",
    });
    expect(() => service.consume(result.selectionId)).toThrowError(
      expect.objectContaining({ code: "DIRECTORY_SELECTION_UNAVAILABLE" }),
    );
  });

  it("expires selections and maps invalid directories to a safe error", async () => {
    let now = 100;
    const service = createService(
      { path: "C:\\picked", status: "selected" },
      { now: () => now, selectionLifetimeMilliseconds: 5 },
    );
    const result = await service.pick();
    if (result.status !== "selected") {
      throw new Error("Expected a selected directory.");
    }
    now = 105;
    expect(() => service.consume(result.selectionId)).toThrowError(
      expect.objectContaining({ code: "DIRECTORY_SELECTION_UNAVAILABLE" }),
    );

    const invalid = createService(
      { path: "C:\\missing", status: "selected" },
      { resolverFailure: true },
    );
    await expect(invalid.pick()).rejects.toMatchObject({
      code: "AUTHORIZED_DIRECTORY_INVALID",
      message: "The selected path is not an accessible local directory.",
    });
  });
});

function createService(
  result: DirectoryPickerResult,
  options: {
    canonicalPath?: string;
    now?: () => number;
    resolverFailure?: boolean;
    selectionLifetimeMilliseconds?: number;
  } = {},
): DirectorySelectionService {
  const picker: DirectoryPicker = {
    async pick(): Promise<DirectoryPickerResult> {
      return result;
    },
  };
  return new DirectorySelectionService(picker, {
    directoryResolver: {
      async canonicalizeDirectory(path): Promise<string> {
        if (options.resolverFailure === true) {
          throw new Error("raw filesystem detail");
        }
        return options.canonicalPath ?? path;
      },
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.selectionLifetimeMilliseconds === undefined
      ? {}
      : {
          selectionLifetimeMilliseconds: options.selectionLifetimeMilliseconds,
        }),
  });
}
