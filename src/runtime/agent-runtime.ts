import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { DeviceAuthService } from "../auth/device-auth-service.js";
import { InMemoryDeviceConnectionRegistry } from "../auth/device-connection-registry.js";
import {
  buildLocalAdminApp,
  type LocalAdminStatus,
} from "../local-admin/app.js";
import { buildRemoteApiApp } from "../remote-api/app.js";
import { openStorage, type StorageConnection } from "../storage/database.js";
import {
  clearTransientEventOverflow,
  pruneStorage,
} from "../storage/maintenance.js";
import { readAgentMasterKey } from "../storage/master-key.js";
import { SettingsRepository } from "../storage/settings-repository.js";
import { TaskEventJournal } from "../tasks/task-event-journal.js";
import { TaskManager } from "../tasks/task-manager.js";
import {
  removeRuntimeControlState,
  writeRuntimeControlState,
} from "./control-state.js";
import {
  DEFAULT_LOCAL_ADMIN_PORT,
  LOCAL_ADMIN_HOST,
  type RuntimeSettings,
  readRuntimeSettings,
} from "./settings.js";

export type BoundListener = {
  host: string;
  port: number;
};

export type AgentRuntimeStatus = LocalAdminStatus;

export type AgentRuntimeOptions = {
  databasePath: string;
  environment?: NodeJS.ProcessEnv;
  installSignalHandlers?: boolean;
  localAdminPort?: number;
  runtimeControlPath?: string;
};

/** Owns both listeners and the single coordinated Agent shutdown path. */
export class AgentRuntime {
  private readonly deviceConnectionRegistry =
    new InMemoryDeviceConnectionRegistry();
  private controlStatePath: string;
  private deviceAuthService: DeviceAuthService | undefined;
  private localAdminApp:
    | Awaited<ReturnType<typeof buildLocalAdminApp>>
    | undefined;
  private localAdminListener: BoundListener | undefined;
  private readonly localAdminPort: number;
  private masterKey: Buffer | undefined;
  private remoteApiApp:
    | Awaited<ReturnType<typeof buildRemoteApiApp>>
    | undefined;
  private remoteListener: BoundListener | undefined;
  private shutdownControlToken: string | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private storage: StorageConnection | undefined;
  private stoppedResolver: (() => void) | undefined;
  private readonly stoppedPromise: Promise<void>;
  private taskManager: TaskManager | undefined;
  private taskEventJournal: TaskEventJournal | undefined;
  private runtimeStarted = false;

  public constructor(private readonly options: AgentRuntimeOptions) {
    this.controlStatePath =
      options.runtimeControlPath ??
      join(dirname(options.databasePath), "runtime-control.json");
    this.localAdminPort = options.localAdminPort ?? DEFAULT_LOCAL_ADMIN_PORT;
    this.stoppedPromise = new Promise((resolve) => {
      this.stoppedResolver = resolve;
    });
  }

  public async start(): Promise<AgentRuntimeStatus> {
    this.masterKey = readAgentMasterKey(this.options.environment);
    try {
      this.storage = openStorage({ databasePath: this.options.databasePath });
      clearTransientEventOverflow(this.storage.sqlite);
      pruneStorage(this.storage.sqlite);

      const settingsRepository = new SettingsRepository(this.storage.database);
      const settings = readRuntimeSettings(settingsRepository);
      this.deviceAuthService = new DeviceAuthService({
        closeDeviceConnections: this.deviceConnectionRegistry,
        masterKey: this.masterKey,
        settingsRepository,
        sqlite: this.storage.sqlite,
      });
      this.taskEventJournal = new TaskEventJournal({
        masterKey: this.masterKey,
        sqlite: this.storage.sqlite,
      });
      this.taskManager = new TaskManager({
        eventSink: this.taskEventJournal,
        settingsRepository,
        sqlite: this.storage.database,
      });
      this.taskManager.recoverFromUnexpectedRestart();
      await this.startListeners(settings, this.deviceAuthService);
      this.installSignalHandlers();
      this.runtimeStarted = true;
      return this.currentStatus(settings);
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.stopResources();
    return this.shutdownPromise;
  }

  public waitUntilStopped(): Promise<void> {
    return this.stoppedPromise;
  }

  private async startListeners(
    settings: RuntimeSettings,
    deviceAuthService: DeviceAuthService,
  ): Promise<void> {
    const csrfToken = createControlToken();
    const shutdownControlToken = createControlToken();
    this.shutdownControlToken = shutdownControlToken;
    this.localAdminApp = await buildLocalAdminApp({
      csrfProtection: {
        expectedOrigin: () => {
          const port = this.localAdminListener?.port ?? this.localAdminPort;
          return `http://${LOCAL_ADMIN_HOST}:${port}`;
        },
        token: csrfToken,
      },
      deviceAuthService,
      getStatus: () => this.currentStatus(settings),
      requestShutdown: () => {
        setTimeout(() => {
          void this.shutdown();
        }, 0);
      },
      shutdownControlToken,
    });
    this.remoteApiApp = await buildRemoteApiApp({
      connectionRegistry: this.deviceConnectionRegistry,
      deviceAuthService,
      ...(this.taskEventJournal === undefined
        ? {}
        : { eventJournal: this.taskEventJournal }),
    });

    await this.localAdminApp.listen({
      host: LOCAL_ADMIN_HOST,
      port: this.localAdminPort,
    });
    this.localAdminListener = listenerAddress(
      this.localAdminApp.server.address(),
    );

    await this.remoteApiApp.listen({
      host: settings.remoteListener.host,
      port: settings.remoteListener.port,
    });
    this.remoteListener = listenerAddress(this.remoteApiApp.server.address());

    await writeRuntimeControlState(this.controlStatePath, {
      localAdminPort: this.localAdminListener.port,
      shutdownControlToken,
      version: 1,
    });
  }

  private currentStatus(settings: RuntimeSettings): AgentRuntimeStatus {
    if (
      this.localAdminListener === undefined ||
      this.remoteListener === undefined
    ) {
      throw new Error("The Agent listeners are not running.");
    }

    return {
      localAdminListener: this.localAdminListener,
      ...(settings.mobileBaseUrl === undefined
        ? {}
        : { mobileBaseUrl: settings.mobileBaseUrl }),
      remoteListener: this.remoteListener,
      status: "running",
    };
  }

  private installSignalHandlers(): void {
    if (this.options.installSignalHandlers === false) {
      return;
    }

    process.once("SIGINT", () => {
      void this.shutdown();
    });
    process.once("SIGTERM", () => {
      void this.shutdown();
    });
  }

  private async stopResources(): Promise<void> {
    const closers: Array<Promise<void>> = [];
    if (this.remoteApiApp !== undefined) {
      closers.push(this.remoteApiApp.close());
    }
    if (this.localAdminApp !== undefined) {
      closers.push(this.localAdminApp.close());
    }

    const taskShutdown =
      this.runtimeStarted && this.taskManager !== undefined
        ? this.taskManager.shutdown()
        : undefined;
    try {
      await taskShutdown;
    } finally {
      await Promise.allSettled(closers);
      this.storage?.close();
      this.storage = undefined;
      this.masterKey?.fill(0);
      this.masterKey = undefined;
      this.deviceAuthService = undefined;
      this.taskManager = undefined;
      this.taskEventJournal = undefined;
      this.runtimeStarted = false;
      await removeRuntimeControlState(
        this.controlStatePath,
        this.shutdownControlToken,
      );
      this.shutdownControlToken = undefined;
      this.stoppedResolver?.();
      this.stoppedResolver = undefined;
    }
  }
}

function createControlToken(): string {
  return randomBytes(32).toString("base64url");
}

function listenerAddress(address: string | AddressInfo | null): BoundListener {
  if (address === null || typeof address === "string") {
    throw new Error("The Agent listener did not expose a TCP address.");
  }

  return {
    host: address.address,
    port: address.port,
  };
}
