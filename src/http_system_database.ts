import {
  SystemDatabase,
  WorkflowStatusInternal,
  SystemDatabaseStoredResult,
  MetricData,
  SOLIDACTIONS_STREAM_CLOSED_SENTINEL,
} from './system_database';
import { HttpClient } from './http_client';
import { SolidActionsHttpConfig } from './config';
import { GlobalLogger } from './telemetry/logs';
import { GetPendingWorkflowsOutput, GetWorkflowsInput, StatusString } from './workflow';
import { operation_outputs } from '../schemas/system_db_schema';
import { sleepms } from './utils';
import { SolidActionsExternalState } from './solidactions-executor';
import { SolidActionsSerializer } from './serialization';
import { SolidActionsWorkflowCancelledError, SolidActionsNonExistentWorkflowError } from './error';

/**
 * HTTP-based implementation of SystemDatabase.
 *
 * This class replaces PostgresSystemDatabase and communicates with
 * the Laravel backend via HTTP API calls instead of direct database access.
 */
export class HttpSystemDatabase implements SystemDatabase {
  private client: HttpClient;
  private executorID: string;
  private appVersion: string;
  private logger: GlobalLogger;
  private readonly serializer: SolidActionsSerializer;

  // In-memory tracking of running workflows (same as PostgresSystemDatabase)
  private readonly runningWorkflows: Map<string, Promise<unknown>> = new Map();
  private readonly workflowCancellationMap: Map<string, boolean> = new Map();

  // Polling intervals for operations that need to wait
  private readonly pollIntervalMs: number = 1000;
  private readonly eventPollIntervalMs: number = 1000;

  constructor(
    config: SolidActionsHttpConfig,
    executorID: string,
    appVersion: string,
    logger: GlobalLogger,
    serializer: SolidActionsSerializer,
  ) {
    // HTTP client with extended retry: 10 retries, ~2 minute window
    // This ensures transient Laravel outages don't cause workflow failures
    this.client = new HttpClient(
      {
        baseUrl: config.apiUrl,
        apiKey: config.apiKey,
        timeout: config.timeout,
        maxRetries: 10,
        retryDelay: 1000,
        maxRetryDelay: 60000, // Cap at 60 seconds between retries
      },
      logger,
    );

    this.executorID = executorID;
    this.appVersion = appVersion;
    this.logger = logger;
    this.serializer = serializer;
  }

  getSerializer(): SolidActionsSerializer {
    return this.serializer;
  }

  // ==========================================
  // Lifecycle Methods
  // ==========================================

  async init(_debugMode?: boolean): Promise<void> {
    // HTTP version: Just verify connectivity by calling health endpoint
    // Note: Migrations are Laravel's responsibility
    try {
      await this.client.get<{ status: string }>('/health');
      this.logger.info('Connected to SolidActions HTTP API');
    } catch (error) {
      this.logger.error(
        `Failed to connect to SolidActions HTTP API: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async destroy(): Promise<void> {
    // HTTP version: No persistent connections to close
    // Just await running workflows
    await this.awaitRunningWorkflows();
  }

  // ==========================================
  // Workflow Status Methods
  // ==========================================

  async initWorkflowStatus(
    initStatus: WorkflowStatusInternal,
    ownerXid: string | null,
    options?: {
      isRecoveryRequest?: boolean;
      isDequeuedRequest?: boolean;
      maxRetries?: number;
    },
  ): Promise<{ status: string; shouldExecuteOnThisExecutor: boolean; deadlineEpochMS?: number }> {
    const response = await this.client.post<{
      status: string;
      shouldExecuteOnThisExecutor: boolean;
      deadlineEpochMS?: number;
    }>('/runs/status', {
      ...initStatus,
      ownerXid,
      options,
    });
    return response;
  }

  async recordWorkflowOutput(workflowID: string, status: WorkflowStatusInternal): Promise<void> {
    await this.client.put(`/runs/status/${encodeURIComponent(workflowID)}/output`, {
      output: status.output,
      status: status.status,
    });
  }

  async recordWorkflowError(workflowID: string, status: WorkflowStatusInternal): Promise<void> {
    await this.client.put(`/runs/status/${encodeURIComponent(workflowID)}/error`, {
      error: status.error,
      status: status.status,
    });
  }

  async getWorkflowStatus(
    workflowID: string,
    callerID?: string,
    callerFN?: number,
  ): Promise<WorkflowStatusInternal | null> {
    try {
      const params = new URLSearchParams();
      if (callerID) params.set('callerID', callerID);
      if (callerFN !== undefined) params.set('callerFN', callerFN.toString());
      const queryString = params.toString();
      const path = `/runs/status/${encodeURIComponent(workflowID)}${queryString ? `?${queryString}` : ''}`;

      const response = await this.client.get<WorkflowStatusInternal | null>(path);
      return response;
    } catch (error) {
      if (error instanceof SolidActionsNonExistentWorkflowError) {
        return null;
      }
      throw error;
    }
  }

  async getPendingWorkflows(executorID: string, appVersion: string): Promise<GetPendingWorkflowsOutput[]> {
    const response = await this.client.get<GetPendingWorkflowsOutput[]>(
      `/runs/status/pending?executorId=${encodeURIComponent(executorID)}&appVersion=${encodeURIComponent(appVersion)}`,
    );
    return response;
  }

  async listWorkflows(input: GetWorkflowsInput): Promise<WorkflowStatusInternal[]> {
    const params = new URLSearchParams();
    if (input.workflowName) params.set('workflowName', input.workflowName);
    if (input.authenticatedUser) params.set('authenticatedUser', input.authenticatedUser);
    if (input.startTime) params.set('startTime', input.startTime);
    if (input.endTime) params.set('endTime', input.endTime);
    if (input.status) params.set('status', input.status);
    if (input.applicationVersion) params.set('applicationVersion', input.applicationVersion);
    if (input.limit !== undefined) params.set('limit', input.limit.toString());
    if (input.offset !== undefined) params.set('offset', input.offset.toString());
    if (input.workflow_id_prefix) params.set('workflowIdPrefix', input.workflow_id_prefix);
    if (input.sortDesc !== undefined) params.set('sortDesc', input.sortDesc.toString());

    const queryString = params.toString();
    const response = await this.client.get<WorkflowStatusInternal[]>(
      `/runs/status${queryString ? `?${queryString}` : ''}`,
    );
    return response;
  }

  // ==========================================
  // Operation Result Methods
  // ==========================================

  async getOperationResultAndThrowIfCancelled(
    workflowID: string,
    functionID: number,
  ): Promise<SystemDatabaseStoredResult | undefined> {
    try {
      const response = await this.client.get<SystemDatabaseStoredResult | null>(
        `/runs/status/${encodeURIComponent(workflowID)}/operations/${functionID}`,
      );

      if (response === null) {
        return undefined;
      }

      // Check if cancelled
      if (response.cancelled) {
        throw new SolidActionsWorkflowCancelledError(workflowID);
      }

      return response;
    } catch (error) {
      if (error instanceof SolidActionsNonExistentWorkflowError) {
        return undefined;
      }
      throw error;
    }
  }

  async getAllOperationResults(workflowID: string): Promise<operation_outputs[]> {
    const response = await this.client.get<operation_outputs[]>(
      `/runs/status/${encodeURIComponent(workflowID)}/operations`,
    );
    return response;
  }

  async recordOperationResult(
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
  ): Promise<void> {
    await this.client.post(`/runs/status/${encodeURIComponent(workflowID)}/operations`, {
      functionID,
      functionName,
      checkConflict,
      startTimeEpochMs,
      endTimeEpochMs: Date.now(),
      ...options,
    });
  }

  // ==========================================
  // Workflow Result Awaiting (Polling-based)
  // ==========================================

  async awaitWorkflowResult(
    workflowID: string,
    timeoutSeconds?: number,
    callerID?: string,
    timerFuncID?: number,
  ): Promise<SystemDatabaseStoredResult | undefined> {
    const deadline = timeoutSeconds ? Date.now() + timeoutSeconds * 1000 : undefined;

    while (!deadline || Date.now() < deadline) {
      try {
        const params = new URLSearchParams();
        if (callerID) params.set('callerID', callerID);
        if (timerFuncID !== undefined) params.set('timerFuncID', timerFuncID.toString());
        const queryString = params.toString();

        const result = await this.client.get<SystemDatabaseStoredResult | null>(
          `/runs/status/${encodeURIComponent(workflowID)}/result${queryString ? `?${queryString}` : ''}`,
        );

        if (result !== null) {
          // Check if workflow is no longer pending
          const status = await this.getWorkflowStatus(workflowID);
          if (status && status.status !== StatusString.PENDING) {
            return result;
          }
        }
      } catch (error) {
        // If workflow not found, return undefined
        if (error instanceof SolidActionsNonExistentWorkflowError) {
          return undefined;
        }
        throw error;
      }

      await sleepms(this.pollIntervalMs);
    }

    // Timeout reached
    return undefined;
  }

  // ==========================================
  // Workflow Control Methods
  // ==========================================

  async setWorkflowStatus(
    workflowID: string,
    status: (typeof StatusString)[keyof typeof StatusString],
    resetRecoveryAttempts: boolean,
  ): Promise<void> {
    await this.client.put(`/runs/status/${encodeURIComponent(workflowID)}/status`, {
      status,
      resetRecoveryAttempts,
    });
  }

  async cancelWorkflow(workflowID: string): Promise<void> {
    await this.client.post(`/runs/status/${encodeURIComponent(workflowID)}/cancel`, {});
    // Update local cancellation map
    this.workflowCancellationMap.set(workflowID, true);
  }

  async resumeWorkflow(workflowID: string): Promise<void> {
    await this.client.post(`/runs/status/${encodeURIComponent(workflowID)}/resume`, {});
    // Clear local cancellation status
    this.workflowCancellationMap.delete(workflowID);
  }

  async forkWorkflow(
    workflowID: string,
    startStep: number,
    options?: { newWorkflowID?: string; applicationVersion?: string; timeoutMS?: number },
  ): Promise<string> {
    const response = await this.client.post<{ newWorkflowID: string }>(
      `/runs/status/${encodeURIComponent(workflowID)}/fork`,
      {
        startStep,
        ...options,
      },
    );
    return response.newWorkflowID;
  }

  async checkIfCanceled(workflowID: string): Promise<void> {
    // Check local cache first
    if (this.workflowCancellationMap.get(workflowID)) {
      throw new SolidActionsWorkflowCancelledError(workflowID);
    }

    // Check with server
    const response = await this.client.get<{ cancelled: boolean }>(
      `/runs/status/${encodeURIComponent(workflowID)}/cancelled`,
    );

    if (response.cancelled) {
      this.workflowCancellationMap.set(workflowID, true);
      throw new SolidActionsWorkflowCancelledError(workflowID);
    }
  }

  // ==========================================
  // Running Workflow Tracking (In-Memory)
  // ==========================================

  registerRunningWorkflow(workflowID: string, workflowPromise: Promise<unknown>): void {
    this.runningWorkflows.set(workflowID, workflowPromise);
    void workflowPromise.finally(() => {
      this.runningWorkflows.delete(workflowID);
      this.workflowCancellationMap.delete(workflowID);
    });
  }

  checkForRunningWorkflow(workflowID: string): boolean {
    return this.runningWorkflows.has(workflowID);
  }

  async awaitRunningWorkflows(): Promise<void> {
    await Promise.allSettled(this.runningWorkflows.values());
  }

  // ==========================================
  // Messaging Methods (send/recv/sleep)
  // ==========================================

  async send(
    workflowID: string,
    functionID: number,
    destinationID: string,
    message: string | null,
    topic?: string,
  ): Promise<void> {
    await this.client.post(`/runs/status/${encodeURIComponent(destinationID)}/messages`, {
      senderWorkflowID: workflowID,
      functionID,
      message,
      topic,
    });
  }

  async recv(
    workflowID: string,
    functionID: number,
    timeoutFunctionID: number,
    topic?: string,
    timeoutSeconds?: number,
  ): Promise<string | null> {
    // Check if cancelled first
    await this.checkIfCanceled(workflowID);

    // Check for existing result or message
    // The server handles this in one call - it checks:
    // 1. If operation output exists (we already received or timed out) -> returns it
    // 2. If notification exists -> consumes it, creates operation output, returns it
    // 3. Otherwise -> returns found: false
    const params = new URLSearchParams();
    if (topic) params.set('topic', topic);
    params.set('functionID', functionID.toString());
    params.set('timeoutFunctionID', timeoutFunctionID.toString());
    const queryString = params.toString();

    const response = await this.client.get<{ message: string | null; found: boolean }>(
      `/runs/status/${encodeURIComponent(workflowID)}/messages?${queryString}`,
    );

    if (response.found) {
      // Either: a message was received, or we previously timed out (null stored as result)
      return response.message;
    }

    // No message and no previous result - register as waiting and exit container
    // Server will:
    // 1. Record operation output with null (marks that we started waiting)
    // 2. Set workflow_run.status to 'waiting'
    // 3. Optionally schedule timeout action
    console.log(`[SolidActions] No message found for recv - registering as waiting and exiting`);
    await this.client.post(`/runs/status/${encodeURIComponent(workflowID)}/wait`, {
      functionID,
      topic,
      timeoutSeconds,
    });

    // Exit the process - scheduler will wake us up when signal arrives or on timeout
    console.log(`[SolidActions] Durable recv - exiting container. Will resume when signal arrives.`);
    process.exit(0);
  }

  async durableSleepms(workflowID: string, functionID: number, duration: number): Promise<void> {
    // Check if this sleep was already recorded (resume case)
    const existingOp = await this.getOperationResultAndThrowIfCancelled(workflowID, functionID);
    if (existingOp) {
      // Sleep was already recorded - check if we should still wait
      const wakeupTime = existingOp.output ? JSON.parse(existingOp.output).wakeupTime : 0;
      const remainingMs = wakeupTime - Date.now();
      if (remainingMs <= 0) {
        // Wakeup time passed, continue without waiting
        console.log(`[SolidActions] Sleep already recorded and wakeup time passed - continuing`);
        return;
      }
      // Still need to wait - this shouldn't happen if scheduler is working correctly
      console.log(`[SolidActions] Sleep recorded but wakeup time not yet reached - exiting for scheduler`);
    } else {
      // Operation not found - this is a new sleep, record it
      console.log(`[SolidActions] Recording durable sleep for ${duration}ms`);
      await this.client.post(`/runs/status/${encodeURIComponent(workflowID)}/sleep`, {
        functionID,
        duration,
        wakeupTime: Date.now() + duration,
      });
    }

    // Exit the process - scheduler will wake us up
    // Server has already set workflow_run.status to 'sleeping'
    console.log(`[SolidActions] Durable sleep - exiting container. Scheduler will resume.`);
    process.exit(0);
  }

  // ==========================================
  // Webhook Output Methods
  // ==========================================

  async setWebhookOutput(workflowID: string, body: unknown): Promise<void> {
    await this.client.put(`/runs/status/${encodeURIComponent(workflowID)}/webhook-output`, { body });
  }

  // ==========================================
  // Event Methods
  // ==========================================

  async setEvent(workflowID: string, functionID: number, key: string, value: string | null): Promise<void> {
    await this.client.put(`/runs/status/${encodeURIComponent(workflowID)}/events/${encodeURIComponent(key)}`, {
      functionID,
      value,
    });
  }

  async getEvent(
    workflowID: string,
    key: string,
    timeoutSeconds: number,
    callerWorkflow?: {
      workflowID: string;
      functionID: number;
      timeoutFunctionID: number;
    },
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      const params = new URLSearchParams();
      if (callerWorkflow) {
        params.set('callerWorkflowID', callerWorkflow.workflowID);
        params.set('callerFunctionID', callerWorkflow.functionID.toString());
        params.set('callerTimeoutFunctionID', callerWorkflow.timeoutFunctionID.toString());
      }
      const queryString = params.toString();

      const response = await this.client.get<{ value: string | null; found: boolean }>(
        `/runs/status/${encodeURIComponent(workflowID)}/events/${encodeURIComponent(key)}${queryString ? `?${queryString}` : ''}`,
      );

      if (response.found) {
        return response.value;
      }

      await sleepms(this.eventPollIntervalMs);
    }

    // Timeout reached
    return null;
  }

  // ==========================================
  // Event Dispatch State Methods
  // ==========================================

  async getEventDispatchState(
    service: string,
    workflowFnName: string,
    key: string,
  ): Promise<SolidActionsExternalState | undefined> {
    try {
      const response = await this.client.get<SolidActionsExternalState | null>(
        `/event-dispatch/${encodeURIComponent(service)}/${encodeURIComponent(workflowFnName)}/${encodeURIComponent(key)}`,
      );
      return response ?? undefined;
    } catch (error) {
      if (error instanceof SolidActionsNonExistentWorkflowError) {
        return undefined;
      }
      throw error;
    }
  }

  async upsertEventDispatchState(state: SolidActionsExternalState): Promise<SolidActionsExternalState> {
    const response = await this.client.put<SolidActionsExternalState>('/event-dispatch', state);
    return response;
  }

  // ==========================================
  // Streaming Methods
  // ==========================================

  async writeStreamFromWorkflow(workflowID: string, functionID: number, key: string, value: unknown): Promise<void> {
    await this.client.post(`/runs/status/${encodeURIComponent(workflowID)}/streams/${encodeURIComponent(key)}`, {
      fromWorkflow: true,
      functionID,
      value,
    });
  }

  async writeStreamFromStep(workflowID: string, key: string, value: unknown): Promise<void> {
    await this.client.post(`/runs/status/${encodeURIComponent(workflowID)}/streams/${encodeURIComponent(key)}`, {
      fromWorkflow: false,
      value,
    });
  }

  async closeStream(workflowID: string, functionID: number, key: string): Promise<void> {
    await this.client.post(`/runs/status/${encodeURIComponent(workflowID)}/streams/${encodeURIComponent(key)}/close`, {
      functionID,
    });
  }

  async readStream(workflowID: string, key: string, offset: number): Promise<unknown> {
    const response = await this.client.get<{ value: unknown; closed: boolean }>(
      `/runs/status/${encodeURIComponent(workflowID)}/streams/${encodeURIComponent(key)}/${offset}`,
    );

    if (response.closed) {
      return SOLIDACTIONS_STREAM_CLOSED_SENTINEL;
    }

    return response.value;
  }

  // ==========================================
  // Admin Methods
  // ==========================================

  async garbageCollect(cutoffEpochTimestampMs?: number, rowsThreshold?: number): Promise<void> {
    await this.client.post('/admin/garbage-collect', {
      cutoffEpochTimestampMs,
      rowsThreshold,
    });
  }

  async getMetrics(startTime: string, endTime: string): Promise<MetricData[]> {
    const response = await this.client.get<MetricData[]>(
      `/admin/metrics?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`,
    );
    return response;
  }

  async checkPatch(
    workflowID: string,
    functionID: number,
    patchName: string,
    deprecated: boolean,
  ): Promise<{ isPatched: boolean; hasEntry: boolean }> {
    const params = new URLSearchParams();
    params.set('patchName', patchName);
    params.set('deprecated', deprecated.toString());

    const response = await this.client.get<{ isPatched: boolean; hasEntry: boolean }>(
      `/runs/status/${encodeURIComponent(workflowID)}/patch/${functionID}?${params.toString()}`,
    );
    return response;
  }
}
