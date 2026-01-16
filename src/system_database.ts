/**
 * System Database Interface and Types
 *
 * This module defines the interface for workflow state persistence.
 * The implementation uses HTTP API calls to a Laravel backend.
 *
 * @see HttpSystemDatabase for the implementation
 */

import { GetPendingWorkflowsOutput, GetWorkflowsInput, StatusString } from './workflow';
import { operation_outputs } from '../schemas/system_db_schema';
import { SolidActionsExternalState } from './solidactions-executor';
import { SolidActionsSerializer } from './serialization';

/* Result from System Database */
export interface SystemDatabaseStoredResult {
  output?: string | null;
  error?: string | null;
  cancelled?: boolean;
  childWorkflowID?: string | null;
  functionName?: string;
}

// Function name constants for internal operations
export const SOLIDACTIONS_FUNCNAME_SEND = 'SolidActions.send';
export const SOLIDACTIONS_FUNCNAME_RECV = 'SolidActions.recv';
export const SOLIDACTIONS_FUNCNAME_SETEVENT = 'SolidActions.setEvent';
export const SOLIDACTIONS_FUNCNAME_GETEVENT = 'SolidActions.getEvent';
export const SOLIDACTIONS_FUNCNAME_SLEEP = 'SolidActions.sleep';
export const SOLIDACTIONS_FUNCNAME_GETSTATUS = 'getStatus';
export const SOLIDACTIONS_FUNCNAME_WRITESTREAM = 'SolidActions.writeStream';
export const SOLIDACTIONS_FUNCNAME_CLOSESTREAM = 'SolidActions.closeStream';

export const SOLIDACTIONS_STREAM_CLOSED_SENTINEL = '__SOLIDACTIONS_STREAM_CLOSED__';

/**
 * General notes:
 *   The responsibilities of the `SystemDatabase` are to store data for workflows, and
 *     associated steps, transactions, messages, and events.  The system DB is
 *     also the IPC mechanism that performs notifications when things change, for
 *     example a receive is unblocked when a send occurs, or a cancel interrupts
 *     the receive.
 *   The `SystemDatabase` expects values in inputs/outputs/errors to be JSON.  However,
 *     the serialization process of turning data into JSON or converting it back, should
 *     be done elsewhere (executor), as it may require application-specific logic or extensions.
 */
export interface SystemDatabase {
  init(debugMode?: boolean): Promise<void>;
  destroy(): Promise<void>;

  initWorkflowStatus(
    initStatus: WorkflowStatusInternal,
    ownerXid: string | null,
    options?: {
      isRecoveryRequest?: boolean;
      isDequeuedRequest?: boolean;
      maxRetries?: number;
    },
  ): Promise<{ status: string; shouldExecuteOnThisExecutor: boolean; deadlineEpochMS?: number }>;
  recordWorkflowOutput(workflowID: string, status: WorkflowStatusInternal): Promise<void>;
  recordWorkflowError(workflowID: string, status: WorkflowStatusInternal): Promise<void>;

  getPendingWorkflows(executorID: string, appVersion: string): Promise<GetPendingWorkflowsOutput[]>;

  // If there is no record, res will be undefined;
  //  otherwise will be defined (with potentially undefined contents)
  getOperationResultAndThrowIfCancelled(
    workflowID: string,
    functionID: number,
  ): Promise<SystemDatabaseStoredResult | undefined>;
  getAllOperationResults(workflowID: string): Promise<operation_outputs[]>;
  recordOperationResult(
    workflowID: string,
    functionID: number,
    functionName: string,
    checkConflict: boolean,
    startTimeEpochMs: number,
    options?: {
      childWorkflowID?: string | null;
      output?: string | null;
      error?: string | null;
    },
  ): Promise<void>;

  getWorkflowStatus(workflowID: string, callerID?: string, callerFN?: number): Promise<WorkflowStatusInternal | null>;
  awaitWorkflowResult(
    workflowID: string,
    timeoutSeconds?: number,
    callerID?: string,
    timerFuncID?: number,
  ): Promise<SystemDatabaseStoredResult | undefined>;

  // Workflow management
  setWorkflowStatus(
    workflowID: string,
    status: (typeof StatusString)[keyof typeof StatusString],
    resetRecoveryAttempts: boolean,
  ): Promise<void>;
  cancelWorkflow(workflowID: string): Promise<void>;
  resumeWorkflow(workflowID: string): Promise<void>;
  forkWorkflow(
    workflowID: string,
    startStep: number,
    options?: { newWorkflowID?: string; applicationVersion?: string; timeoutMS?: number },
  ): Promise<string>;
  checkIfCanceled(workflowID: string): Promise<void>;
  registerRunningWorkflow(workflowID: string, workflowPromise: Promise<unknown>): void;
  checkForRunningWorkflow(workflowID: string): boolean;
  awaitRunningWorkflows(): Promise<void>; // Use in clean shutdown

  // Actions w/ durable records and notifications
  durableSleepms(workflowID: string, functionID: number, duration: number): Promise<void>;

  send(
    workflowID: string,
    functionID: number,
    destinationID: string,
    message: string | null,
    topic?: string,
  ): Promise<void>;
  recv(
    workflowID: string,
    functionID: number,
    timeoutFunctionID: number,
    topic?: string,
    timeoutSeconds?: number,
  ): Promise<string | null>;

  setEvent(workflowID: string, functionID: number, key: string, value: string | null): Promise<void>;
  getEvent(
    workflowID: string,
    key: string,
    timeoutSeconds: number,
    callerWorkflow?: {
      workflowID: string;
      functionID: number;
      timeoutFunctionID: number;
    },
  ): Promise<string | null>;

  // Event receiver state queries / updates
  getEventDispatchState(
    service: string,
    workflowFnName: string,
    key: string,
  ): Promise<SolidActionsExternalState | undefined>;
  upsertEventDispatchState(state: SolidActionsExternalState): Promise<SolidActionsExternalState>;

  // Streaming
  writeStreamFromWorkflow(workflowID: string, functionID: number, key: string, value: unknown): Promise<void>;
  writeStreamFromStep(workflowID: string, key: string, value: unknown): Promise<void>;
  closeStream(workflowID: string, functionID: number, key: string): Promise<void>;
  readStream(workflowID: string, key: string, offset: number): Promise<unknown>;

  // Workflow management
  listWorkflows(input: GetWorkflowsInput): Promise<WorkflowStatusInternal[]>;
  garbageCollect(cutoffEpochTimestampMs?: number, rowsThreshold?: number): Promise<void>;
  getMetrics(startTime: string, endTime: string): Promise<MetricData[]>;

  // Patching
  checkPatch(
    workflowID: string,
    functionID: number,
    patchName: string,
    deprecated: boolean,
  ): Promise<{ isPatched: boolean; hasEntry: boolean }>;

  getSerializer(): SolidActionsSerializer;
}

// For internal use, not serialized status.
export interface WorkflowStatusInternal {
  workflowUUID: string;
  status: string;
  workflowName: string;
  workflowClassName: string;
  workflowConfigName: string;
  queueName?: string;
  authenticatedUser: string;
  output: string | null;
  error: string | null; // Serialized error
  input: string | null;
  assumedRole: string;
  authenticatedRoles: string[];
  request: object;
  executorId: string;
  applicationVersion?: string;
  applicationID: string;
  createdAt: number;
  updatedAt?: number;
  recoveryAttempts?: number;
  timeoutMS?: number;
  deadlineEpochMS?: number;
  deduplicationID?: string;
  priority: number;
  queuePartitionKey?: string;
  forkedFrom?: string;
}

export interface EnqueueOptions {
  // Unique ID for deduplication on a queue
  deduplicationID?: string;
  // Priority of the workflow on the queue, starting from 1 ~ 2,147,483,647. Default 0 (highest priority).
  priority?: number;
  // Partition key for partitioned queues
  queuePartitionKey?: string;
}

export interface ExistenceCheck {
  exists: boolean;
}

export interface MetricData {
  metricType: string;
  metricName: string;
  value: number;
}

// Re-export HttpSystemDatabase as the default implementation
export { HttpSystemDatabase } from './http_system_database';
