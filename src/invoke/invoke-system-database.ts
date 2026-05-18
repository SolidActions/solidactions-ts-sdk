/**
 * InvokeSystemDatabase — an HttpSystemDatabase subclass for the resident/invoke model.
 *
 * The base class calls process.exit(0) after posting sleep/wait schedules to signal
 * suspension to the container scheduler. Under a resident invoke() model the process
 * must not exit; instead, suspension is signalled by throwing SuspensionRequired so
 * the invoke() caller can return { status: 'suspended', reason }.
 *
 * The base's durableSleepms and recv both follow the same pattern:
 *   1. Check pre-conditions / existing operation (public API we can call via super).
 *   2. POST the schedule/wait to the Laravel backend (done via private client — not
 *      accessible to subclasses, so we carry our own HttpClient for these two POSTs).
 *   3. Call process.exit(0) — replaced here by `throw new SuspensionRequired(reason)`.
 *
 * No base-class fields or private methods are accessed; only the constructor args and
 * public methods (getOperationResultAndThrowIfCancelled, checkIfCanceled) are reused.
 */

import { HttpSystemDatabase } from '../http_system_database';
import { SolidActionsHttpConfig } from '../config';
import { GlobalLogger } from '../telemetry/logs';
import { SolidActionsSerializer } from '../serialization';
import { HttpClient } from '../http_client';

// ---------------------------------------------------------------------------
// SuspensionRequired
// ---------------------------------------------------------------------------

/**
 * Thrown by InvokeSystemDatabase instead of calling process.exit(0) when a
 * workflow suspends (sleep or recv-wait). The invoke() runner catches this and
 * maps it to { status: 'suspended', reason }.
 */
export class SuspensionRequired extends Error {
  readonly reason: 'sleep' | 'recv';

  constructor(reason: 'sleep' | 'recv') {
    super(`Workflow suspended: ${reason}`);
    this.name = 'SuspensionRequired';
    this.reason = reason;
    // Restore prototype chain (required when extending Error in TypeScript)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Per-run identity (passed explicitly — no process.env / globals)
// ---------------------------------------------------------------------------

export interface InvokeRunIdentity {
  /** Executor identifier for this invocation. */
  executorID: string;
  /** Application version string. */
  appVersion: string;
}

// ---------------------------------------------------------------------------
// InvokeSystemDatabase
// ---------------------------------------------------------------------------

export class InvokeSystemDatabase extends HttpSystemDatabase {
  /** Own HTTP client for the two suspension POSTs (sleep, wait). */
  private readonly invokeClient: HttpClient;

  constructor(
    config: SolidActionsHttpConfig,
    identity: InvokeRunIdentity,
    logger: GlobalLogger,
    serializer: SolidActionsSerializer,
  ) {
    super(config, identity.executorID, identity.appVersion, logger, serializer);

    // Own client: same retry policy as the base — the suspension POST must survive
    // transient backend outages, matching base policy, because a dropped POST
    // silently stalls the workflow (backend never records the sleep/wait, scheduler
    // never wakes it). Extended retries protect against that outcome.
    this.invokeClient = new HttpClient(
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
  }

  /**
   * Override: post the sleep schedule, then throw SuspensionRequired('sleep')
   * instead of calling process.exit(0).
   *
   * Mirrors base logic (http_system_database.ts lines 451-479):
   *   - If operation exists and wakeup has passed → return (resume path).
   *   - Otherwise → POST sleep, throw SuspensionRequired.
   */
  override async durableSleepms(workflowID: string, functionID: number, duration: number): Promise<void> {
    const existingOp = await this.getOperationResultAndThrowIfCancelled(workflowID, functionID);
    if (existingOp) {
      const wakeupTime = existingOp.output ? (JSON.parse(existingOp.output) as { wakeupTime: number }).wakeupTime : 0;
      const remainingMs = wakeupTime - Date.now();
      if (remainingMs <= 0) {
        // Wakeup time passed — continue without suspending (resume path)
        return;
      }
      // Already recorded but wakeup not yet reached — do not re-POST; suspend again.
    } else {
      // New sleep: record it with the backend
      await this.invokeClient.post(`/runs/status/${encodeURIComponent(workflowID)}/sleep`, {
        functionID,
        duration,
        wakeupTime: Date.now() + duration,
      });
    }

    // Signal suspension to the invoke() caller — never exit the process
    throw new SuspensionRequired('sleep');
  }

  /**
   * Override: post the recv-wait, then throw SuspensionRequired('recv')
   * instead of calling process.exit(0).
   *
   * Mirrors base logic (http_system_database.ts lines 404-448):
   *   - Check cancelled.
   *   - GET messages; if found (already received or timed out) → return the message.
   *   - Otherwise → POST wait, throw SuspensionRequired.
   */
  override async recv(
    workflowID: string,
    functionID: number,
    timeoutFunctionID: number,
    topic?: string,
    timeoutSeconds?: number,
  ): Promise<string | null> {
    // Delegate the cancel check + message lookup to the base via its public HTTP calls.
    // We cannot call super.recv() because it calls process.exit on the "no message" path,
    // so we replicate the cancel-check + GET-messages logic using our own client.
    await this.checkIfCanceled(workflowID);

    const params = new URLSearchParams();
    if (topic) { params.set('topic', topic); }
    params.set('functionID', functionID.toString());
    params.set('timeoutFunctionID', timeoutFunctionID.toString());

    const response = await this.invokeClient.get<{ message: string | null; found: boolean }>(
      `/runs/status/${encodeURIComponent(workflowID)}/messages?${params.toString()}`,
    );

    if (response.found) {
      // Message already available (or previously timed out)
      return response.message;
    }

    // No message yet — register as waiting
    await this.invokeClient.post(`/runs/status/${encodeURIComponent(workflowID)}/wait`, {
      functionID,
      topic,
      timeoutSeconds,
    });

    // Signal suspension — never exit the process
    throw new SuspensionRequired('recv');
  }
}
