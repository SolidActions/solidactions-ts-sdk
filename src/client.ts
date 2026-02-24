import {
  type SystemDatabase,
  HttpSystemDatabase,
  type WorkflowStatusInternal,
  SOLIDACTIONS_STREAM_CLOSED_SENTINEL,
} from './system_database';
import { getHttpConfig, SolidActionsHttpConfig } from './config';

import { GlobalLogger } from './telemetry/logs';
import { randomUUID } from 'node:crypto';
import {
  type GetWorkflowsInput,
  isWorkflowActive,
  StatusString,
  type StepInfo,
  type WorkflowHandle,
  type WorkflowStatus,
} from './workflow';
import { sleepms, globalParams } from './utils';
import { SolidActionsJSON, SolidActionsSerializer } from './serialization';
import { forkWorkflow, getWorkflow, listWorkflows, listWorkflowSteps, toWorkflowStatus } from './workflow_management';
import { SolidActionsExecutor } from './solidactions-executor';
import { SolidActionsAwaitedWorkflowCancelledError } from './error';

export class ClientHandle<R> implements WorkflowHandle<R> {
  constructor(
    readonly systemDatabase: SystemDatabase,
    readonly workflowUUID: string,
  ) {}

  getWorkflowUUID(): string {
    return this.workflowUUID;
  }

  get workflowID(): string {
    return this.workflowUUID;
  }

  async getStatus(): Promise<WorkflowStatus | null> {
    const status = await this.systemDatabase.getWorkflowStatus(this.workflowUUID);
    return status ? toWorkflowStatus(status, this.systemDatabase.getSerializer()) : null;
  }

  async getResult(): Promise<R> {
    const res = await this.systemDatabase.awaitWorkflowResult(this.workflowID);
    if (res?.cancelled) {
      throw new SolidActionsAwaitedWorkflowCancelledError(this.workflowID);
    }
    return SolidActionsExecutor.reviveResultOrError<R>(res!, this.systemDatabase.getSerializer());
  }

  async getWorkflowInputs<T extends unknown[]>(): Promise<T> {
    const status = (await this.systemDatabase.getWorkflowStatus(this.workflowUUID)) as WorkflowStatusInternal;
    return this.systemDatabase.getSerializer().parse(status.input) as T;
  }
}

/**
 * SolidActionsClient is the main entry point for interacting with the SolidActions system.
 */
export class SolidActionsClient {
  private readonly logger: GlobalLogger;
  private readonly systemDatabase: SystemDatabase;

  private constructor(
    systemDatabase: SystemDatabase,
    readonly serializer: SolidActionsSerializer,
  ) {
    this.logger = new GlobalLogger();
    this.systemDatabase = systemDatabase;
  }

  /**
   * Creates a new instance of the SolidActionsClient.
   * Uses HTTP API to communicate with the backend.
   * @param options - Configuration options
   * @param options.httpConfig - HTTP API configuration - if not provided, reads from environment (SOLIDACTIONS_API_URL, SOLIDACTIONS_API_KEY)
   * @param options.serializer - Custom serializer to use (optional)
   * @returns The SolidActionsClient instance.
   */
  static create({
    httpConfig,
    serializer,
  }: {
    httpConfig?: SolidActionsHttpConfig;
    serializer?: SolidActionsSerializer;
  } = {}): SolidActionsClient {
    const logger = new GlobalLogger();
    const effectiveSerializer = serializer ?? SolidActionsJSON;
    const config = httpConfig ?? getHttpConfig();

    const systemDatabase = new HttpSystemDatabase(
      config,
      globalParams.executorID,
      globalParams.appVersion,
      logger,
      effectiveSerializer,
    );

    return new SolidActionsClient(systemDatabase, effectiveSerializer);
  }

  /**
   * Destroys the underlying database connection.
   * This should be called when the client is no longer needed to clean up resources.
   * @returns A Promise that resolves when database connection is destroyed.
   */
  async destroy() {
    await this.systemDatabase.destroy();
  }

  /**
   * Sends a message to a workflow, identified by destinationID.
   * @param destinationID - The ID of the destination workflow.
   * @param message - The message to send. This can be any serializable object.
   * @param topic - An optional topic to send the message to. If not provided, the default topic will be used.
   * @param idempotencyKey - An optional idempotency key to ensure that the message is only sent once.
   * @returns A Promise that resolves when the message has been sent.
   */
  async send<T>(destinationID: string, message: T, topic?: string, idempotencyKey?: string): Promise<void> {
    idempotencyKey ??= randomUUID();
    const internalStatus: WorkflowStatusInternal = {
      workflowUUID: `${destinationID}-${idempotencyKey}`,
      status: StatusString.SUCCESS,
      workflowName: 'temp_workflow-send-client',
      workflowClassName: '',
      workflowConfigName: '',
      authenticatedUser: '',
      output: null,
      error: null,
      assumedRole: '',
      authenticatedRoles: [],
      request: {},
      executorId: '',
      applicationID: globalParams.appID,
      createdAt: Date.now(),
      input: this.serializer.stringify([destinationID, message, topic]),
      deduplicationID: undefined,
      priority: 0,
      queuePartitionKey: undefined,
    };
    await this.systemDatabase.initWorkflowStatus(internalStatus, null);
    await this.systemDatabase.send(
      internalStatus.workflowUUID,
      0,
      destinationID,
      this.serializer.stringify(message),
      topic,
    );
  }

  /**
   * Retrieves an event published by workflowID for a given key.
   * @param workflowID - The ID of the workflow that published the event.
   * @param key - The key associated with the event you want to retrieve.
   * @param timeoutSeconds - Optional timeout in seconds for how long to wait for the event to be available.
   * @returns A Promise that resolves with the event payload.
   */
  async getEvent<T>(workflowID: string, key: string, timeoutSeconds?: number): Promise<T | null> {
    return this.serializer.parse(await this.systemDatabase.getEvent(workflowID, key, timeoutSeconds ?? 60)) as T;
  }

  /**
   * Retrieves a single workflow by its id.
   * @param workflowID - The ID of the workflow to retrieve.
   * @returns a WorkflowHandle that represents the retrieved workflow.
   */
  retrieveWorkflow<T = unknown>(workflowID: string): WorkflowHandle<Awaited<T>> {
    return new ClientHandle(this.systemDatabase, workflowID);
  }

  cancelWorkflow(workflowID: string): Promise<void> {
    return this.systemDatabase.cancelWorkflow(workflowID);
  }

  resumeWorkflow(workflowID: string): Promise<void> {
    return this.systemDatabase.resumeWorkflow(workflowID);
  }

  forkWorkflow(
    workflowID: string,
    startStep: number,
    options?: { newWorkflowID?: string; applicationVersion?: string; timeoutMS?: number },
  ): Promise<string> {
    return forkWorkflow(this.systemDatabase, workflowID, startStep, options);
  }

  getWorkflow(workflowID: string): Promise<WorkflowStatus | undefined> {
    return getWorkflow(this.systemDatabase, workflowID);
  }

  listWorkflows(input: GetWorkflowsInput): Promise<WorkflowStatus[]> {
    return listWorkflows(this.systemDatabase, input);
  }

  listWorkflowSteps(workflowID: string): Promise<StepInfo[] | undefined> {
    return listWorkflowSteps(this.systemDatabase, workflowID);
  }

  /**
   * Read values from a stream as an async generator.
   * This function reads values from a stream identified by the workflowID and key,
   * yielding each value in order until the stream is closed or the workflow terminates.
   * @param workflowID - The ID of the workflow that wrote to the stream
   * @param key - The stream key to read from
   * @returns An async generator that yields each value in the stream until the stream is closed
   */
  async *readStream<T>(workflowID: string, key: string): AsyncGenerator<T, void, unknown> {
    let offset = 0;

    while (true) {
      try {
        const value = await this.systemDatabase.readStream(workflowID, key, offset);
        if (value === SOLIDACTIONS_STREAM_CLOSED_SENTINEL) {
          break;
        }
        yield value as T;
        offset += 1;
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('No value found')) {
          // Poll the offset until a value arrives or the workflow terminates
          const status = await this.getWorkflow(workflowID);
          if (!status || !isWorkflowActive(status.status)) {
            break;
          }
          await sleepms(1000); // 1 second polling interval
          continue;
        }
        throw error;
      }
    }
  }
}
