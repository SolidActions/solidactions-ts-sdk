/**
 * HTTP State Driver for SolidActions
 *
 * Implements durable step state by persisting operations to Laravel via HTTP calls.
 * This allows workflows to survive container restarts and enables replay semantics.
 */

import { createHash } from 'crypto';

/**
 * Operation result stored in the database
 */
export interface OpResult {
  config: {
    id: string;
    code: string;
    data?: Record<string, unknown>;
  };
  result: {
    status: 'ok' | 'error' | 'plan';
    data?: unknown;
    error?: {
      message: string;
      stack?: string;
      canRetry?: boolean;
    };
  };
}

/**
 * Configuration for the HTTP State Driver
 */
export interface HttpStateDriverConfig {
  baseUrl: string;
  runId: string;
  authToken: string;
  workerSessionId?: string;
}

/**
 * Signal information returned when preparing a signal waiter
 */
export interface SignalInfo {
  signalName: string;
  signalToken: string;
  signalUrl: string;
  hashedOpId: string;
  stepId: string;
}

/**
 * Handle returned when spawning a child workflow
 */
export interface ChildWorkflowHandle {
  childRunId: string;
  workflowRunId: number;
  workflowId: string;
}

/**
 * Status of a child workflow
 */
export interface ChildWorkflowStatus {
  status: string;
  result?: unknown;
  error?: unknown;
}

/**
 * Hash a step ID to create a unique operation identifier
 */
export function hashOpId(stepId: string, index: number = 0): string {
  const input = `${stepId}:${index}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 16);
}

/**
 * HTTP State Driver
 *
 * Persists step operations to Laravel's internal API.
 * Used by the SolidActions client to enable durable workflow execution.
 */
export class HttpStateDriver {
  private baseUrl: string;
  private runId: string;
  private authToken: string;
  private workerSessionId?: string;

  constructor(config: HttpStateDriverConfig) {
    this.baseUrl = config.baseUrl;
    this.runId = config.runId;
    this.authToken = config.authToken;
    this.workerSessionId = config.workerSessionId;
  }

  /**
   * Get a cached operation result from the database
   */
  async getOp(hashedOpId: string): Promise<OpResult | undefined> {
    const url = `${this.baseUrl}/api/internal/runs/${this.runId}/steps/${hashedOpId}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        Accept: 'application/json',
      },
    });

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(`Failed to get operation: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<OpResult>;
  }

  /**
   * Save an operation result to the database
   */
  async setOp(hashedOpId: string, stepId: string, op: OpResult, input?: unknown): Promise<void> {
    const url = `${this.baseUrl}/api/internal/runs/${this.runId}/steps`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        hashed_op_id: hashedOpId,
        step_id: stepId,
        step_index: 0,
        op_code: op.config.code,
        op_config: op.config.data,
        status: op.result.status === 'ok' ? 'completed' : op.result.status === 'error' ? 'error' : 'pending',
        output: op.result.data,
        error: op.result.error,
        worker_session_id: this.workerSessionId,
        input: input,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to save operation: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Schedule a sleep and exit the container
   */
  async scheduleSleep(hashedOpId: string, stepId: string, durationMs: number, input?: unknown): Promise<never> {
    const url = `${this.baseUrl}/api/internal/runs/${this.runId}/sleep`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        hashed_op_id: hashedOpId,
        step_id: stepId,
        duration_ms: durationMs,
        worker_session_id: this.workerSessionId,
        input: input,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to schedule sleep: ${response.status} ${response.statusText}`);
    }

    // Exit the container - Laravel will resume later
    console.log(`[SolidActions] Sleep scheduled for ${durationMs}ms. Container exiting.`);
    process.exit(0);
  }

  /**
   * Signal info returned from prepareSignalWaiter
   */
  private lastSignalInfo?: SignalInfo;

  /**
   * Register a signal waiter and return signal info (without exiting)
   * This allows workflows to get signal URLs before sending emails.
   */
  async prepareSignalWaiter(
    hashedOpId: string,
    stepId: string,
    signalName: string,
    timeoutMs?: number,
    input?: unknown
  ): Promise<SignalInfo> {
    const url = `${this.baseUrl}/api/internal/runs/${this.runId}/wait-signal`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        hashed_op_id: hashedOpId,
        step_id: stepId,
        signal_name: signalName,
        timeout_ms: timeoutMs,
        worker_session_id: this.workerSessionId,
        input: input,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to register signal waiter: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      signal_name: string;
      signal_token: string;
      signal_url: string;
    };

    const signalInfo: SignalInfo = {
      signalName: data.signal_name,
      signalToken: data.signal_token,
      signalUrl: data.signal_url,
      hashedOpId,
      stepId,
    };

    this.lastSignalInfo = signalInfo;
    return signalInfo;
  }

  /**
   * Exit the container after signal has been prepared
   */
  exitForSignal(signalInfo: SignalInfo): never {
    console.log(`[SolidActions] Waiting for signal "${signalInfo.signalName}". Container exiting.`);
    process.exit(0);
  }

  /**
   * Register a signal waiter and exit the container
   */
  async registerSignalWaiter(
    hashedOpId: string,
    stepId: string,
    signalName: string,
    timeoutMs?: number,
    input?: unknown
  ): Promise<never> {
    await this.prepareSignalWaiter(hashedOpId, stepId, signalName, timeoutMs, input);

    // Exit the container - Laravel will resume on signal or timeout
    console.log(`[SolidActions] Waiting for signal "${signalName}". Container exiting.`);
    process.exit(0);
  }

  /**
   * Mark the run as completed
   */
  async completeRun(result?: unknown): Promise<void> {
    const url = `${this.baseUrl}/api/internal/runs/${this.runId}/complete`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ result }),
    });

    if (!response.ok) {
      throw new Error(`Failed to complete run: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Mark the run as failed
   */
  async failRun(error: { message: string; stack?: string }): Promise<void> {
    const url = `${this.baseUrl}/api/internal/runs/${this.runId}/fail`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ error }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fail run: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Spawn a child workflow
   */
  async spawnChildWorkflow(
    hashedOpId: string,
    stepId: string,
    workflowId: string,
    input: unknown
  ): Promise<ChildWorkflowHandle> {
    const url = `${this.baseUrl}/api/internal/runs/${this.runId}/spawn-child`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        workflow_id: workflowId,
        input,
        step_id: stepId,
        hashed_op_id: hashedOpId,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to spawn child workflow: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const data = (await response.json()) as {
      child_run_id: string;
      workflow_run_id: number;
      workflow_id: string;
    };

    return {
      childRunId: data.child_run_id,
      workflowRunId: data.workflow_run_id,
      workflowId: data.workflow_id,
    };
  }

  /**
   * Get the status of a child workflow
   */
  async getChildStatus(childRunId: string): Promise<ChildWorkflowStatus> {
    const url = `${this.baseUrl}/api/internal/runs/${this.runId}/children/${childRunId}/status`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get child status: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<ChildWorkflowStatus>;
  }

  /**
   * Register that the parent is awaiting a child workflow to complete
   * This will exit the container.
   */
  async registerAwaitChild(
    hashedOpId: string,
    stepId: string,
    childRunId: string,
    input: unknown
  ): Promise<never> {
    const url = `${this.baseUrl}/api/internal/runs/${this.runId}/await-child`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        child_run_id: childRunId,
        step_id: stepId,
        hashed_op_id: hashedOpId,
        input,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to register await child: ${response.status} ${response.statusText}`);
    }

    // Exit the container - Laravel will resume when child completes
    console.log(`[SolidActions] Waiting for child workflow ${childRunId}. Container exiting.`);
    process.exit(0);
  }
}
