import type { TaskOperationLease } from "./task-operation-scheduler.js";
import type { TaskSnapshot } from "./task-types.js";

export type ProviderApprovalRequest = {
  method: string;
  params: unknown;
  provider: string;
  requestId: number | string;
};

/** Shared task policy exposed to provider-native adapters. */
export type ProviderTaskRuntime = {
  approvalRequested(
    taskId: string,
    request: ProviderApprovalRequest,
  ): TaskSnapshot | undefined;
  approvalResolved(
    taskId: string,
    pendingRequestCount: number,
  ): TaskSnapshot | undefined;
  assertReadable(taskId: string): Promise<TaskSnapshot>;
  beginInterrupt(taskId: string): TaskSnapshot;
  completeInterrupt(taskId: string): TaskSnapshot | undefined;
  markTerminal(taskId: string): TaskSnapshot | undefined;
  reserveTurn(taskId: string, lease: TaskOperationLease): Promise<TaskSnapshot>;
  rollbackTurn(taskId: string): TaskSnapshot | undefined;
  run<T>(
    taskId: string,
    operation: (lease: TaskOperationLease) => Promise<T> | T,
  ): Promise<T>;
  turnCompleted(taskId: string): TaskSnapshot | undefined;
  turnStarted(taskId: string, nativeTurnId: string): TaskSnapshot | undefined;
};
