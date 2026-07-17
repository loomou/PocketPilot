import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type DirectoryPickerProcess,
  WindowsDirectoryPicker,
} from "../../src/local-admin/windows-directory-picker.js";

describe("WindowsDirectoryPicker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects unsupported platforms without starting a process", async () => {
    const spawnProcess = vi.fn<() => DirectoryPickerProcess>();
    const picker = new WindowsDirectoryPicker({
      platform: "linux",
      spawnProcess,
    });

    await expect(picker.pick()).rejects.toMatchObject({
      code: "DIRECTORY_PICKER_UNAVAILABLE",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("parses one bounded JSON result and rejects a concurrent picker", async () => {
    const process = new FakePickerProcess();
    const picker = new WindowsDirectoryPicker({
      platform: "win32",
      spawnProcess: () => process,
    });
    const first = picker.pick();

    await expect(picker.pick()).rejects.toMatchObject({
      code: "DIRECTORY_PICKER_BUSY",
    });
    process.stdout.write(
      JSON.stringify({ path: "C:\\project", status: "selected" }),
    );
    process.emit("close", 0);

    await expect(first).resolves.toEqual({
      path: "C:\\project",
      status: "selected",
    });
  });

  it("terminates oversized output and never exposes raw process text", async () => {
    const process = new FakePickerProcess();
    const picker = new WindowsDirectoryPicker({
      maxOutputBytes: 8,
      platform: "win32",
      spawnProcess: () => process,
    });
    const result = picker.pick();
    process.stderr.write("sensitive raw PowerShell failure");

    await expect(result).rejects.toMatchObject({
      code: "DIRECTORY_PICKER_UNAVAILABLE",
      message: "The native directory picker is currently unavailable.",
    });
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("terminates timed-out and aborted picker processes", async () => {
    vi.useFakeTimers();
    const timedOutProcess = new FakePickerProcess();
    const timedOutPicker = new WindowsDirectoryPicker({
      platform: "win32",
      spawnProcess: () => timedOutProcess,
      timeoutMilliseconds: 10,
    });
    const timeoutExpectation = expect(
      timedOutPicker.pick(),
    ).rejects.toMatchObject({ code: "DIRECTORY_PICKER_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(10);
    await timeoutExpectation;
    expect(timedOutProcess.kill).toHaveBeenCalledOnce();

    vi.useRealTimers();
    const abortedProcess = new FakePickerProcess();
    const abortedPicker = new WindowsDirectoryPicker({
      platform: "win32",
      spawnProcess: () => abortedProcess,
    });
    const abortController = new AbortController();
    const abortExpectation = expect(
      abortedPicker.pick(abortController.signal),
    ).rejects.toMatchObject({ code: "DIRECTORY_PICKER_UNAVAILABLE" });
    abortController.abort();
    await abortExpectation;
    expect(abortedProcess.kill).toHaveBeenCalledOnce();
  });
});

class FakePickerProcess extends EventEmitter {
  public readonly kill = vi.fn(() => true);
  public readonly stderr = new PassThrough();
  public readonly stdout = new PassThrough();
}
