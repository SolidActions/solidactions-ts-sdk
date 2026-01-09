/**
 * SolidActions SDK
 *
 * A durable workflow execution SDK that provides:
 * - step.run(): Execute and cache idempotent operations
 * - step.sleep(): Pause workflow execution for a duration
 * - step.waitForSignal(): Wait for external events (human-in-the-loop)
 *
 * All state is persisted to Laravel via HTTP, enabling workflows to:
 * - Survive container crashes and restarts
 * - Sleep for hours/days without consuming resources
 * - Wait for human approval or external events
 *
 * @packageDocumentation
 */

import {
  HttpStateDriver,
  hashOpId,
  type OpResult,
  type SignalInfo,
  type ChildWorkflowHandle,
  type ChildWorkflowStatus,
} from './httpStateDriver.js';
import {
  getWorkflowInput,
  getInputValue,
  getEnvVar,
  requireEnvVar,
  getRunId,
  getTenantId,
  isRunningOnSolidActions,
  log,
  logger,
  calculateBackoff,
  localSleep,
  type BackoffStrategy,
} from './utils.js';

// Re-export utilities
export {
  getWorkflowInput,
  getInputValue,
  getEnvVar,
  requireEnvVar,
  getRunId,
  getTenantId,
  isRunningOnSolidActions,
  log,
  logger,
  calculateBackoff,
  localSleep,
} from './utils.js';
export type { BackoffStrategy } from './utils.js';

export { HttpStateDriver, hashOpId } from './httpStateDriver.js';
export type {
  OpResult,
  HttpStateDriverConfig,
  SignalInfo,
  ChildWorkflowHandle,
  ChildWorkflowStatus,
} from './httpStateDriver.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Workflow context passed to the handler
 */
export interface WorkflowContext<TInput = unknown> {
  /**
   * The input data for this workflow run.
   * This is immutable - pass explicit inputs to steps instead of mutating.
   */
  readonly input: Readonly<TInput>;
  /** The unique run ID */
  readonly runId: string;
  /** Environment variables */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Options for step.run with retry support
 */
export interface StepRunOptions {
  /** Number of retries (default: 0 - no retries) */
  retries?: number;
  /** Backoff strategy: 'exponential', 'linear', or fixed number in ms (default: 'exponential') */
  backoff?: BackoffStrategy;
  /** Base delay in ms for backoff calculation (default: 1000) */
  backoffBase?: number;
}

/**
 * Options for awaiting a child workflow
 */
export interface AwaitWorkflowOptions {
  /** Inline polling timeout in ms before registering durable wait (default: 3000) */
  inlineTimeout?: number;
}

/**
 * Prepared signal that can be awaited
 */
export interface PreparedSignal<T = unknown> {
  /** The signal URL that can be used in emails/webhooks */
  url: string;
  /** The signal token */
  token: string;
  /** The signal name */
  name: string;
  /**
   * Helper to create URL with a choice parameter
   * @param choice - The choice value to include in the URL
   */
  urlWithChoice(choice: string): string;
  /**
   * Wait for the signal (exits the container)
   * Call this after sending the email with signal URLs.
   */
  wait(): Promise<T | null>;
}

/**
 * Step interface for executing durable operations
 */
export interface Step {
  /**
   * Execute an operation with durability guarantees.
   * If the operation was already executed, returns the cached result.
   * Supports SDK-internal retries (non-durable, within single container run).
   *
   * @param id - Unique identifier for this step
   * @param input - Data to pass to the handler (captured for observability)
   * @param handler - Function to execute, receives input as parameter
   * @param options - Optional retry configuration
   * @returns The result of the handler
   *
   * @example
   * // Basic usage
   * const result = await step.run('process', { userId: 123 }, async (input) => {
   *   return await processUser(input.userId);
   * });
   *
   * // With retries
   * const result = await step.run('api-call', { url }, async (input) => {
   *   return await fetch(input.url);
   * }, { retries: 3, backoff: 'exponential', backoffBase: 1000 });
   */
  run<T, I = unknown>(
    id: string,
    input: I,
    handler: (input: I) => T | Promise<T>,
    options?: StepRunOptions
  ): Promise<T>;

  /**
   * Sleep for a specified duration.
   * The container will exit and be resumed by Laravel after the duration.
   *
   * @param id - Unique identifier for this sleep step
   * @param durationMs - Duration to sleep in milliseconds
   */
  sleep(id: string, durationMs: number): Promise<void>;

  /**
   * Prepare a signal waiter and get URLs without exiting.
   * Use this when you need to send an email with buttons before waiting.
   *
   * @example
   * ```typescript
   * const signal = await step.prepareSignal('approval', { timeout: 86400000 });
   * await step.run('send-email', async () => {
   *   await sendEmail({
   *     buttons: [
   *       { text: 'Approve', url: signal.urlWithChoice('approve') },
   *       { text: 'Reject', url: signal.urlWithChoice('reject') },
   *     ]
   *   });
   * });
   * const result = await signal.wait(); // This will exit and wait for signal
   * ```
   *
   * @param id - Unique identifier for this step
   * @param options - Signal configuration
   * @returns PreparedSignal with URLs and wait function
   */
  prepareSignal<T = unknown>(
    id: string,
    options: { signal: string; timeout?: number }
  ): Promise<PreparedSignal<T>>;

  /**
   * Wait for an external signal.
   * The container will exit and be resumed when the signal is received or timeout occurs.
   *
   * @param id - Unique identifier for this step
   * @param options - Signal configuration
   * @returns The signal data, or null if timed out
   */
  waitForSignal<T = unknown>(
    id: string,
    options: { signal: string; timeout?: number }
  ): Promise<T | null>;

  /**
   * Spawn a child workflow.
   * Returns a handle that can be used to await the child's result.
   *
   * @param id - Unique identifier for this step
   * @param workflowId - The workflow to spawn (slug or name)
   * @param input - Input data for the child workflow
   * @returns Handle to track and await the child workflow
   */
  spawnWorkflow(
    id: string,
    workflowId: string,
    input: unknown
  ): Promise<ChildWorkflowHandle>;

  /**
   * Wait for a child workflow to complete.
   * Will poll inline for a short period, then exit and wait durably.
   *
   * @param id - Unique identifier for this step
   * @param handle - The child workflow handle from spawnWorkflow
   * @param options - Configuration options
   * @returns The child workflow's result
   */
  awaitWorkflow<T = unknown>(
    id: string,
    handle: ChildWorkflowHandle,
    options?: AwaitWorkflowOptions
  ): Promise<T>;

  /**
   * Spawn a child workflow and wait for its result.
   * Convenience method combining spawnWorkflow + awaitWorkflow.
   *
   * @param id - Unique identifier for this step
   * @param workflowId - The workflow to spawn (slug or name)
   * @param input - Input data for the child workflow
   * @param options - Configuration options
   * @returns The child workflow's result
   */
  runWorkflow<T = unknown>(
    id: string,
    workflowId: string,
    input: unknown,
    options?: AwaitWorkflowOptions
  ): Promise<T>;
}

/**
 * Error information for a failed step
 */
export interface StepError {
  message: string;
  stack?: string;
  attempt?: number;
}

/**
 * Collection of errors that occurred during workflow execution
 */
export interface WorkflowErrors {
  [stepId: string]: StepError;
}

/**
 * Options for workflow definition
 */
export interface WorkflowOptions {
  /** Unique workflow identifier */
  id: string;
  /** Maximum retry attempts for failed steps */
  maxAttempts?: number;
  /**
   * Error handler called when the workflow fails.
   * Use this for cleanup, notifications, or compensation logic.
   *
   * @param ctx - The workflow context
   * @param errors - Map of step IDs to their errors
   *
   * @example
   * ```typescript
   * SOLID.workflow(
   *   {
   *     id: 'process-order',
   *     onFailure: async (ctx, errors) => {
   *       await notifyAdmin(`Order ${ctx.input.orderId} failed`, errors);
   *     }
   *   },
   *   async (ctx, step) => { ... }
   * );
   * ```
   */
  onFailure?: (ctx: WorkflowContext, errors: WorkflowErrors) => Promise<void>;
}

/**
 * Workflow handler function type
 */
export type WorkflowHandler<TInput, TOutput> = (
  ctx: WorkflowContext<TInput>,
  step: Step
) => Promise<TOutput>;

/**
 * Workflow definition
 */
export interface Workflow<TInput = unknown, TOutput = unknown> {
  id: string;
  handler: WorkflowHandler<TInput, TOutput>;
  maxAttempts: number;
  onFailure?: (ctx: WorkflowContext<TInput>, errors: WorkflowErrors) => Promise<void>;
}

// ============================================================================
// SolidActions Client
// ============================================================================

/**
 * SolidActions Client for defining and executing durable workflows.
 *
 * @example
 * ```typescript
 * import { SOLID } from '@solidactions/sdk';
 *
 * export const processOrder = SOLID.workflow(
 *   { id: 'process-order' },
 *   async (ctx, step) => {
 *     const validated = await step.run('validate', async () => {
 *       return validateOrder(ctx.input.data);
 *     });
 *
 *     await step.sleep('wait', 60 * 60 * 1000); // 1 hour
 *
 *     const approval = await step.waitForSignal('approval', {
 *       signal: `order-${ctx.input.orderId}`,
 *       timeout: 24 * 60 * 60 * 1000, // 24 hours
 *     });
 *
 *     return { validated, approved: !!approval };
 *   }
 * );
 * ```
 */
export class SolidActionsClient {
  private stateDriver: HttpStateDriver | null = null;
  private workflows: Map<string, Workflow<unknown, unknown>> = new Map();

  // Error tracking for onFailure handler
  private currentStepId: string | null = null;
  private currentStepAttempt: number = 1;

  readonly id = 'solidactions';

  constructor() {
    // Initialize state driver if environment variables are present
    this.initializeDriver();
  }

  private initializeDriver(): void {
    const baseUrl = process.env.SOLIDACTIONS_API_URL;
    const runId = process.env.SOLIDACTIONS_RUN_ID;
    const authToken = process.env.SOLIDACTIONS_AUTH_TOKEN;
    const workerSessionId = process.env.SOLIDACTIONS_WORKER_SESSION_ID;

    if (baseUrl && runId && authToken) {
      this.stateDriver = new HttpStateDriver({
        baseUrl,
        runId,
        authToken,
        workerSessionId,
      });
    }
  }

  /**
   * Define a new workflow
   */
  workflow<TInput = unknown, TOutput = unknown>(
    options: WorkflowOptions,
    handler: WorkflowHandler<TInput, TOutput>
  ): Workflow<TInput, TOutput> {
    const workflow: Workflow<TInput, TOutput> = {
      id: options.id,
      handler,
      maxAttempts: options.maxAttempts ?? 4,
      onFailure: options.onFailure as Workflow<TInput, TOutput>['onFailure'],
    };

    this.workflows.set(workflow.id, workflow as Workflow<unknown, unknown>);
    return workflow;
  }

  /**
   * Execute a workflow (called by the runner)
   */
  async executeWorkflow<TInput = unknown, TOutput = unknown>(
    workflowId: string,
    input: TInput
  ): Promise<TOutput> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow "${workflowId}" not found`);
    }

    if (!this.stateDriver) {
      throw new Error('State driver not initialized. Missing SOLIDACTIONS_* environment variables.');
    }

    const runId = process.env.SOLIDACTIONS_RUN_ID!;

    // Deep clone and freeze input to make it immutable
    const frozenInput = Object.freeze(structuredClone(input)) as TInput;

    const ctx: WorkflowContext<TInput> = Object.freeze({
      input: frozenInput,
      runId,
      env: Object.freeze({ ...process.env }) as Readonly<Record<string, string | undefined>>,
    });

    const step = this.createStep();

    console.log(`[SolidActions] Executing workflow "${workflowId}" (run: ${runId})`);

    try {
      const result = await (workflow.handler as WorkflowHandler<TInput, TOutput>)(ctx, step);

      // Mark run as completed
      await this.stateDriver.completeRun(result);

      console.log(`[SolidActions] Workflow "${workflowId}" completed successfully`);
      return result;
    } catch (error) {
      // Build error context for onFailure handler
      const errors: WorkflowErrors = {
        [this.currentStepId || 'unknown']: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          attempt: this.currentStepAttempt,
        },
      };

      // Call onFailure handler if defined
      if (workflow.onFailure) {
        try {
          console.log(`[SolidActions] Calling onFailure handler for workflow "${workflowId}"`);
          await (workflow.onFailure as (ctx: WorkflowContext<TInput>, errors: WorkflowErrors) => Promise<void>)(ctx, errors);
        } catch (handlerError) {
          console.error(`[SolidActions] onFailure handler threw an error:`, handlerError);
          // Don't rethrow - the original error is more important
        }
      }

      // Mark run as failed
      const errorObj = error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error) };

      await this.stateDriver.failRun(errorObj);

      console.error(`[SolidActions] Workflow "${workflowId}" failed:`, error);
      throw error;
    }
  }

  /**
   * Create a step interface for the current execution
   */
  private createStep(): Step {
    const driver = this.stateDriver!;
    const client = this; // Capture for error tracking

    return {
      async run<T, I = unknown>(
        id: string,
        input: I,
        handler: (input: I) => T | Promise<T>,
        options?: StepRunOptions
      ): Promise<T> {
        const hashedId = hashOpId(id);
        const { retries = 0, backoff = 'exponential', backoffBase = 1000 } = options ?? {};

        // Track current step for error context
        client.currentStepId = id;
        client.currentStepAttempt = 1;

        // Check if step was already executed
        const existing = await driver.getOp(hashedId);
        if (existing && existing.result.status === 'ok') {
          console.log(`[SolidActions] Step "${id}" replayed from cache`);
          return existing.result.data as T;
        }

        // Execute the step with explicit input and retry logic
        console.log(`[SolidActions] Executing step "${id}"${retries > 0 ? ` (max ${retries + 1} attempts)` : ''}`);
        const startTime = Date.now();
        let lastError: Error | unknown;

        for (let attempt = 1; attempt <= retries + 1; attempt++) {
          client.currentStepAttempt = attempt;
          try {
            const result = await handler(input);
            const duration = Date.now() - startTime;

            // Save successful result with the actual input data
            await driver.setOp(hashedId, id, {
              config: { id, code: 'step.run' },
              result: { status: 'ok', data: result },
            }, input);

            console.log(`[SolidActions] Step "${id}" completed in ${duration}ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
            return result;
          } catch (error) {
            lastError = error;
            const errorMessage = error instanceof Error ? error.message : String(error);

            if (attempt <= retries) {
              // More attempts remaining - log and retry
              const delay = calculateBackoff(attempt, backoff, backoffBase);
              console.warn(`[SolidActions] Step "${id}" failed (attempt ${attempt}/${retries + 1}): ${errorMessage}`);
              console.log(`[SolidActions] Retrying in ${delay}ms...`);
              await localSleep(delay);
            } else {
              // All attempts exhausted
              const duration = Date.now() - startTime;
              const errorObj = error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack, canRetry: false }
                : { name: 'Error', message: String(error), canRetry: false };

              // Save error result with the actual input data
              await driver.setOp(hashedId, id, {
                config: { id, code: 'step.run' },
                result: { status: 'error', error: errorObj },
              }, input);

              console.error(`[SolidActions] Step "${id}" failed after ${duration}ms (${retries + 1} attempts):`, error);
            }
          }
        }

        throw lastError;
      },

      async sleep(id: string, durationMs: number): Promise<void> {
        const hashedId = hashOpId(id);

        // Check if sleep was already completed
        const existing = await driver.getOp(hashedId);
        if (existing && existing.result.status === 'ok') {
          console.log(`[SolidActions] Sleep "${id}" already completed, skipping`);
          return;
        }

        // Schedule sleep and exit
        console.log(`[SolidActions] Scheduling sleep "${id}" for ${durationMs}ms`);
        await driver.scheduleSleep(hashedId, id, durationMs, { duration_ms: durationMs });
        // This never returns - process exits
      },

      async prepareSignal<T>(
        id: string,
        options: { signal: string; timeout?: number }
      ): Promise<PreparedSignal<T>> {
        const hashedId = hashOpId(id);

        // Check if signal was already received
        const existing = await driver.getOp(hashedId);
        if (existing && existing.result.status === 'ok') {
          console.log(`[SolidActions] Signal "${options.signal}" already received, returning cached result`);
          // Return a "completed" PreparedSignal that returns cached data on wait()
          const cachedData = existing.result.data as T | null;
          return {
            url: '',
            token: '',
            name: options.signal,
            urlWithChoice: () => '',
            wait: async () => cachedData,
          };
        }

        // Prepare the signal waiter (registers but doesn't exit)
        console.log(`[SolidActions] Preparing signal "${options.signal}"`);
        const signalInfo = await driver.prepareSignalWaiter(
          hashedId,
          id,
          options.signal,
          options.timeout,
          { signal: options.signal, timeout: options.timeout }
        );

        return {
          url: signalInfo.signalUrl,
          token: signalInfo.signalToken,
          name: signalInfo.signalName,
          urlWithChoice: (choice: string) => `${signalInfo.signalUrl}?choice=${encodeURIComponent(choice)}`,
          wait: async (): Promise<T | null> => {
            // Exit and wait for the signal
            driver.exitForSignal(signalInfo);
            return null; // Never reached - process exits
          },
        };
      },

      async waitForSignal<T>(
        id: string,
        options: { signal: string; timeout?: number }
      ): Promise<T | null> {
        const hashedId = hashOpId(id);

        // Check if signal was already received
        const existing = await driver.getOp(hashedId);
        if (existing && existing.result.status === 'ok') {
          console.log(`[SolidActions] Signal "${options.signal}" already received, returning cached result`);
          return existing.result.data as T | null;
        }

        // Register signal waiter and exit
        console.log(`[SolidActions] Waiting for signal "${options.signal}"`);
        await driver.registerSignalWaiter(hashedId, id, options.signal, options.timeout, { signal: options.signal, timeout: options.timeout });
        // This never returns - process exits
        return null; // TypeScript satisfaction (never reached)
      },

      async spawnWorkflow(
        id: string,
        workflowId: string,
        input: unknown
      ): Promise<ChildWorkflowHandle> {
        const hashedId = hashOpId(id);

        // Check if spawn was already executed (replay)
        const existing = await driver.getOp(hashedId);
        if (existing && existing.result.status === 'ok') {
          console.log(`[SolidActions] Child workflow spawn "${id}" replayed from cache`);
          return existing.result.data as ChildWorkflowHandle;
        }

        // Spawn the child workflow
        console.log(`[SolidActions] Spawning child workflow "${workflowId}" from step "${id}"`);
        const handle = await driver.spawnChildWorkflow(hashedId, id, workflowId, input);

        // Save the handle to cache
        await driver.setOp(hashedId, id, {
          config: { id, code: 'step.spawnWorkflow', data: { workflowId } },
          result: { status: 'ok', data: handle },
        }, input);

        console.log(`[SolidActions] Child workflow spawned: ${handle.childRunId}`);
        return handle;
      },

      async awaitWorkflow<T>(
        id: string,
        handle: ChildWorkflowHandle,
        options?: AwaitWorkflowOptions
      ): Promise<T> {
        const hashedId = hashOpId(id);
        const inlineTimeout = options?.inlineTimeout ?? 3000;

        // Check if await was already completed (replay)
        const existing = await driver.getOp(hashedId);
        if (existing && existing.result.status === 'ok') {
          console.log(`[SolidActions] Child workflow await "${id}" replayed from cache`);
          return existing.result.data as T;
        }

        // Inline polling loop
        console.log(`[SolidActions] Awaiting child workflow ${handle.childRunId} (inline timeout: ${inlineTimeout}ms)`);
        const startTime = Date.now();
        const pollInterval = 500;

        while (Date.now() - startTime < inlineTimeout) {
          const status = await driver.getChildStatus(handle.childRunId);

          if (status.status === 'completed') {
            // Child completed! Save result and return
            await driver.setOp(hashedId, id, {
              config: { id, code: 'step.awaitWorkflow', data: { childRunId: handle.childRunId } },
              result: { status: 'ok', data: status.result },
            }, { handle });

            console.log(`[SolidActions] Child workflow ${handle.childRunId} completed inline`);
            return status.result as T;
          }

          if (status.status === 'failed') {
            throw new Error(`Child workflow ${handle.childRunId} failed: ${JSON.stringify(status.error)}`);
          }

          // Wait before next poll
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // Inline timeout exceeded - register durable await and exit
        console.log(`[SolidActions] Inline timeout exceeded, registering durable await for ${handle.childRunId}`);
        await driver.registerAwaitChild(hashedId, id, handle.childRunId, { handle });
        // This never returns - process exits
        return undefined as T; // TypeScript satisfaction (never reached)
      },

      async runWorkflow<T>(
        id: string,
        workflowId: string,
        input: unknown,
        options?: AwaitWorkflowOptions
      ): Promise<T> {
        // Combine spawn + await with distinct step IDs
        const handle = await this.spawnWorkflow(`${id}-spawn`, workflowId, input);
        return await this.awaitWorkflow<T>(`${id}-await`, handle, options);
      },
    };
  }

  /**
   * Get workflow input from environment
   */
  input<T = Record<string, unknown>>(): T | null {
    return getWorkflowInput<T>();
  }

  /**
   * Get a specific input value
   */
  inputValue<T>(key: string, defaultValue?: T): T | undefined {
    return getInputValue<T>(key, defaultValue);
  }

  /**
   * Get an environment variable
   */
  env(name: string, defaultValue?: string): string | undefined {
    return getEnvVar(name, defaultValue);
  }

  /**
   * Require an environment variable
   */
  requireEnv(name: string): string {
    return requireEnvVar(name);
  }

  /**
   * Get the current run ID
   */
  get runId(): string {
    return getRunId();
  }

  /**
   * Check if running on SolidActions platform
   */
  get isOnPlatform(): boolean {
    return isRunningOnSolidActions();
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Default SolidActions client instance.
 *
 * Use this for defining workflows:
 * ```typescript
 * import { SOLID } from '@solidactions/sdk';
 *
 * export const myWorkflow = SOLID.workflow(
 *   { id: 'my-workflow' },
 *   async (ctx, step) => {
 *     // ...
 *   }
 * );
 * ```
 */
export const SOLID = new SolidActionsClient();


export default SOLID;
