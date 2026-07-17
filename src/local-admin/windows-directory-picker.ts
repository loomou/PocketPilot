import { spawn } from "node:child_process";

import { z } from "zod";
import { LocalAdminError } from "./errors.js";

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;

const pickerOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }),
  z.object({
    path: z.string().trim().min(1).max(4_096),
    status: z.literal("selected"),
  }),
]);

const folderPickerScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
try {
  $result = $dialog.ShowDialog()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    @{ status = 'selected'; path = $dialog.SelectedPath } | ConvertTo-Json -Compress
  } else {
    @{ status = 'cancelled' } | ConvertTo-Json -Compress
  }
} finally {
  $dialog.Dispose()
}
`.trim();

export type DirectoryPickerResult =
  | { status: "cancelled" }
  | { path: string; status: "selected" };

export type DirectoryPicker = {
  pick(signal?: AbortSignal): Promise<DirectoryPickerResult>;
};

export type DirectoryPickerProcess = {
  kill(): boolean;
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: () => void): unknown;
  stderr: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
  };
  stdout: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
  };
};

type SpawnPickerProcess = () => DirectoryPickerProcess;

export type WindowsDirectoryPickerOptions = {
  maxOutputBytes?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: SpawnPickerProcess;
  timeoutMilliseconds?: number;
};

/** Opens the foreground Agent's native Windows folder picker. */
export class WindowsDirectoryPicker implements DirectoryPicker {
  readonly #maxOutputBytes: number;
  readonly #platform: NodeJS.Platform;
  readonly #spawnProcess: SpawnPickerProcess;
  readonly #timeoutMilliseconds: number;
  #active = false;

  public constructor(options: WindowsDirectoryPickerOptions = {}) {
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#platform = options.platform ?? process.platform;
    this.#spawnProcess = options.spawnProcess ?? spawnPowerShellPicker;
    this.#timeoutMilliseconds =
      options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  }

  public async pick(signal?: AbortSignal): Promise<DirectoryPickerResult> {
    if (this.#platform !== "win32") {
      throw pickerUnavailableError();
    }
    if (this.#active) {
      throw new LocalAdminError(
        "DIRECTORY_PICKER_BUSY",
        409,
        "Another directory picker is already open on this computer.",
      );
    }
    if (signal?.aborted === true) {
      throw pickerUnavailableError();
    }

    this.#active = true;
    try {
      return await this.runPicker(signal);
    } finally {
      this.#active = false;
    }
  }

  private runPicker(signal?: AbortSignal): Promise<DirectoryPickerResult> {
    let child: DirectoryPickerProcess;
    try {
      child = this.#spawnProcess();
    } catch {
      return Promise.reject(pickerUnavailableError());
    }

    return new Promise((resolvePromise, rejectPromise) => {
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const settle = (
        outcome:
          | { kind: "resolve"; value: DirectoryPickerResult }
          | { error: LocalAdminError; kind: "reject" },
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (outcome.kind === "resolve") {
          resolvePromise(outcome.value);
        } else {
          rejectPromise(outcome.error);
        }
      };
      const terminateWithFailure = (): void => {
        child.kill();
        settle({ error: pickerUnavailableError(), kind: "reject" });
      };
      const abort = (): void => terminateWithFailure();
      const timeout = setTimeout(
        terminateWithFailure,
        this.#timeoutMilliseconds,
      );
      timeout.unref();

      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.#maxOutputBytes) {
          terminateWithFailure();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > this.#maxOutputBytes) {
          terminateWithFailure();
        }
      });
      child.once("error", terminateWithFailure);
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          settle({ error: pickerUnavailableError(), kind: "reject" });
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        } catch {
          settle({ error: pickerUnavailableError(), kind: "reject" });
          return;
        }
        const parsed = pickerOutputSchema.safeParse(value);
        if (!parsed.success) {
          settle({ error: pickerUnavailableError(), kind: "reject" });
          return;
        }
        settle({ kind: "resolve", value: parsed.data });
      });
    });
  }
}

function spawnPowerShellPicker(): DirectoryPickerProcess {
  return spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      folderPickerScript,
    ],
    { shell: false, stdio: "pipe", windowsHide: true },
  );
}

function pickerUnavailableError(): LocalAdminError {
  return new LocalAdminError(
    "DIRECTORY_PICKER_UNAVAILABLE",
    503,
    "The native directory picker is currently unavailable.",
  );
}
