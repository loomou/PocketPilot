import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProviderAdapter } from "../agent-providers/claude-provider-adapter.js";
import { AgentProviderRegistry } from "../agent-providers/registry.js";
import { AgentRuntimeManager } from "../agent-providers/runtime-manager.js";
import { buildMobileOpenApiDocument } from "../api-docs/mobile-openapi.js";
import { DeviceAuthService } from "../auth/device-auth-service.js";
import { InMemoryDeviceConnectionRegistry } from "../auth/device-connection-registry.js";
import {
  CodexAppServerBridge,
  isCodexCommandAvailable,
} from "../codex-app-server/bridge.js";
import { CodexProviderAdapter } from "../codex-app-server/provider-adapter.js";
import { readCodexCommand } from "../config/environment.js";
import {
  buildLocalAdminApp,
  type LocalAdminStatus,
} from "../local-admin/app.js";
import { DirectorySelectionService } from "../local-admin/directory-selection-service.js";
import { WindowsDirectoryPicker } from "../local-admin/windows-directory-picker.js";
import { logEvents } from "../logging/events.js";
import {
  noopLogger,
  type PocketPilotLogger,
  safeErrorFields,
} from "../logging/logger.js";
import { buildRemoteApiApp } from "../remote-api/app.js";
import { InMemoryTaskAgentConnectionRegistry } from "../remote-api/task-agent-connection-registry.js";
import { openStorage, type StorageConnection } from "../storage/database.js";
import {
  clearTransientEventOverflow,
  ensureMasterKeyVerifier,
  pruneStorage,
} from "../storage/maintenance.js";
import { readAgentMasterKey } from "../storage/master-key.js";
import { SettingsRepository } from "../storage/settings-repository.js";
import { TaskEventJournal } from "../tasks/task-event-journal.js";
import { TaskManager } from "../tasks/task-manager.js";
import { TaskRepository } from "../tasks/task-repository.js";
import { acquireAgentLock, type ReleaseAgentLock } from "./agent-lock.js";
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
  developmentMode?: boolean;
  environment?: NodeJS.ProcessEnv;
  installSignalHandlers?: boolean;
  localAdminPort?: number;
  logger?: PocketPilotLogger;
  runtimeControlPath?: string;
};

/** Owns both listeners and the single coordinated Agent shutdown path. */
export class AgentRuntime {
  private readonly deviceConnectionRegistry =
    new InMemoryDeviceConnectionRegistry();
  private readonly taskAgentConnectionRegistry =
    new InMemoryTaskAgentConnectionRegistry();
  private agentRuntimeManager: AgentRuntimeManager | undefined;
  private controlStatePath: string;
  private deviceAuthService: DeviceAuthService | undefined;
  private localAdminApp:
    | Awaited<ReturnType<typeof buildLocalAdminApp>>
    | undefined;
  private localAdminListener: BoundListener | undefined;
  private readonly localAdminPort: number;
  private readonly logger: PocketPilotLogger;
  private masterKey: Buffer | undefined;
  private codexProviderAdapter: CodexProviderAdapter | undefined;
  private remoteApiApp:
    | Awaited<ReturnType<typeof buildRemoteApiApp>>
    | undefined;
  private remoteListener: BoundListener | undefined;
  private releaseAgentLock: ReleaseAgentLock | undefined;
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
    this.logger = options.logger ?? noopLogger;
    this.stoppedPromise = new Promise((resolve) => {
      this.stoppedResolver = resolve;
    });
  }

  public async start(): Promise<AgentRuntimeStatus> {
    this.logger.info(logEvents.runtimeStarting, "Runtime starting");
    try {
      const environment = this.options.environment ?? process.env;
      const masterKey = readAgentMasterKey(environment);
      this.masterKey = masterKey;
      this.releaseAgentLock = await acquireAgentLock(this.options.databasePath);
      this.storage = openStorage({ databasePath: this.options.databasePath });
      ensureMasterKeyVerifier(this.storage.sqlite, masterKey);
      clearTransientEventOverflow(this.storage.sqlite);
      pruneStorage(this.storage.sqlite);
      this.logger.info(logEvents.runtimeStorageReady, "Runtime storage ready");

      const settingsRepository = new SettingsRepository(this.storage.database);
      const settings = readRuntimeSettings(settingsRepository);
      this.deviceAuthService = new DeviceAuthService({
        closeDeviceConnections: this.deviceConnectionRegistry,
        logger: this.logger,
        masterKey,
        settingsRepository,
        sqlite: this.storage.sqlite,
      });
      this.taskEventJournal = new TaskEventJournal({
        masterKey,
        sqlite: this.storage.sqlite,
      });
      this.taskManager = new TaskManager({
        closeTaskAgentConnections: this.taskAgentConnectionRegistry,
        eventSink: this.taskEventJournal,
        logger: this.logger,
        settingsRepository,
        sqlite: this.storage.database,
      });
      const codexCommand = readCodexCommand(environment);
      const resolvedCodexCommand = codexCommand ?? "codex";
      const codexAvailable = isCodexCommandAvailable(
        resolvedCodexCommand,
        environment,
      );
      this.codexProviderAdapter = new CodexProviderAdapter({
        bridge: new CodexAppServerBridge({
          command: resolvedCodexCommand,
          environment,
          logger: this.logger,
        }),
        logger: this.logger,
        repository: new TaskRepository(this.storage.database),
        taskRuntime: this.taskManager.providerTaskRuntime(),
        ...(codexAvailable
          ? {}
          : {
              status: "not_installed" as const,
              statusReasonCode: "CODEX_COMMAND_NOT_FOUND",
            }),
      });
      const agentRuntimeManager = new AgentRuntimeManager(
        new AgentProviderRegistry([
          new ClaudeProviderAdapter(this.taskManager, this.taskEventJournal),
          this.codexProviderAdapter,
        ]),
        this.taskManager,
      );
      this.agentRuntimeManager = agentRuntimeManager;
      this.taskManager.setProviderTaskController({
        close(taskId) {
          const lifecycle =
            agentRuntimeManager.taskProvider(taskId).taskLifecycle;
          if (lifecycle === undefined) {
            throw new Error("The Agent provider does not support task close.");
          }
          return lifecycle.close(taskId);
        },
        interrupt(taskId) {
          const lifecycle =
            agentRuntimeManager.taskProvider(taskId).taskLifecycle;
          if (lifecycle === undefined) {
            throw new Error(
              "The Agent provider does not support interruption.",
            );
          }
          return lifecycle.interrupt(taskId);
        },
        resume(taskId) {
          const lifecycle =
            agentRuntimeManager.taskProvider(taskId).taskLifecycle;
          if (lifecycle === undefined) {
            throw new Error("The Agent provider does not support task resume.");
          }
          return lifecycle.resume(taskId);
        },
      });
      const recoveredTaskCount =
        this.taskManager.recoverFromUnexpectedRestart();
      await this.startListeners(settings, this.deviceAuthService);
      this.installSignalHandlers();
      this.runtimeStarted = true;
      const status = this.currentStatus(settings);
      this.logger.info(logEvents.runtimeStarted, "Runtime started", {
        recoveredTaskCount,
      });
      this.logger.info(
        logEvents.runtimeRemoteHealthReady,
        `Remote health: http://${status.remoteListener.host}:${status.remoteListener.port}/healthz`,
      );
      this.logger.info(
        logEvents.runtimeLocalAdminReady,
        `Local administration: http://${status.localAdminListener.host}:${status.localAdminListener.port}`,
      );
      if (this.options.developmentMode === true) {
        this.logger.info(
          logEvents.runtimeSwaggerReady,
          `Swagger documentation: http://${status.localAdminListener.host}:${status.localAdminListener.port}/documentation/`,
        );
      }
      return status;
    } catch (error) {
      this.logger.error(logEvents.runtimeStartFailed, "Runtime start failed", {
        ...safeErrorFields(error),
      });
      await this.shutdown();
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }

    this.logger.info(
      logEvents.runtimeShutdownRequested,
      "Runtime shutdown requested",
    );
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
    const storage = this.storage;
    if (storage === undefined) {
      throw new Error("Storage must be open before listeners start.");
    }
    const csrfToken = createControlToken();
    const shutdownControlToken = createControlToken();
    const mobileOpenApiDocument = await buildMobileOpenApiDocument();
    this.shutdownControlToken = shutdownControlToken;
    this.localAdminApp = await buildLocalAdminApp({
      ...(this.taskManager === undefined
        ? {}
        : { authorizedDirectoryManager: this.taskManager }),
      csrfProtection: {
        expectedOrigin: () => {
          const port = this.localAdminListener?.port ?? this.localAdminPort;
          return `http://${LOCAL_ADMIN_HOST}:${port}`;
        },
        token: csrfToken,
      },
      deviceAuthService,
      directorySelectionService: new DirectorySelectionService(
        new WindowsDirectoryPicker(),
      ),
      settingsRepository: new SettingsRepository(storage.database),
      staticRoot: resolveLocalAdminStaticRoot(),
      getStatus: () => this.currentStatus(settings),
      mobileOpenApiDocument,
      logger: this.logger,
      requestShutdown: () => {
        setTimeout(() => {
          void this.shutdown();
        }, 0);
      },
      shutdownControlToken,
      sqlite: storage.sqlite,
    });
    this.remoteApiApp = await buildRemoteApiApp({
      ...(this.agentRuntimeManager === undefined
        ? {}
        : { agentRuntimeManager: this.agentRuntimeManager }),
      connectionRegistry: this.deviceConnectionRegistry,
      deviceAuthService,
      ...(this.taskEventJournal === undefined
        ? {}
        : { eventJournal: this.taskEventJournal }),
      ...(this.taskManager === undefined
        ? {}
        : { taskManager: this.taskManager }),
      logger: this.logger,
      taskAgentConnectionRegistry: this.taskAgentConnectionRegistry,
    });

    await this.localAdminApp.listen({
      host: LOCAL_ADMIN_HOST,
      port: this.localAdminPort,
    });
    this.localAdminListener = listenerAddress(
      this.localAdminApp.server.address(),
    );
    this.logger.debug(logEvents.runtimeListenerStarted, "Listener started", {
      host: this.localAdminListener.host,
      listener: "local-admin",
      port: this.localAdminListener.port,
    });

    await this.remoteApiApp.listen({
      host: settings.remoteListener.host,
      port: settings.remoteListener.port,
    });
    this.remoteListener = listenerAddress(this.remoteApiApp.server.address());
    this.logger.debug(logEvents.runtimeListenerStarted, "Listener started", {
      host: this.remoteListener.host,
      listener: "remote",
      port: this.remoteListener.port,
    });

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
    const codexShutdown = this.codexProviderAdapter?.shutdown();
    try {
      await Promise.allSettled(
        [taskShutdown, codexShutdown].filter(
          (promise): promise is Promise<void> => promise !== undefined,
        ),
      );
    } finally {
      await Promise.allSettled(closers);
      this.storage?.close();
      this.storage = undefined;
      this.masterKey?.fill(0);
      this.masterKey = undefined;
      this.agentRuntimeManager = undefined;
      this.codexProviderAdapter = undefined;
      this.deviceAuthService = undefined;
      this.taskManager = undefined;
      this.taskEventJournal = undefined;
      this.runtimeStarted = false;
      const releaseAgentLock = this.releaseAgentLock;
      this.releaseAgentLock = undefined;
      try {
        await removeRuntimeControlState(
          this.controlStatePath,
          this.shutdownControlToken,
        );
      } finally {
        this.shutdownControlToken = undefined;
        try {
          await releaseAgentLock?.();
        } finally {
          this.logger.info(logEvents.runtimeStopped, "Runtime stopped");
          this.stoppedResolver?.();
          this.stoppedResolver = undefined;
        }
      }
    }
  }
}

function createControlToken(): string {
  return randomBytes(32).toString("base64url");
}

function resolveLocalAdminStaticRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packagedRoot = join(moduleDirectory, "local-admin");
  return existsSync(packagedRoot)
    ? packagedRoot
    : join(process.cwd(), "dist", "local-admin");
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
