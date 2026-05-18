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
  readonly reason: 'sleep' | 'recv' | 'child';

  // Task 2.7: 'child' reuses the EXACT sleep/recv suspend machinery (throw →
  // invoke() maps to { status: 'suspended' } → one-shot exits 0 → backend
  // re-pends the parent → re-invoked → replays). It is a new reason literal,
  // NOT a new suspension mechanism or a new endpoint.
  constructor(reason: 'sleep' | 'recv' | 'child') {
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
        workerSessionId: config.workerSessionId,
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
    if (topic) {
      params.set('topic', topic);
    }
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

  /**
   * Task 2.7 — enqueue a child workflow as its own backend run.
   *
   * Reuses the EXISTING `POST /runs/status` endpoint the SDK already calls for
   * a child via initWorkflowStatus (the legacy in-process model only created a
   * RunStatus here). The one-shot backend's child branch additionally creates a
   * pending child RunTrigger so RunTriggerObserver dispatches a child container.
   * The only protocol addition is `childResultFunctionID`: the PARENT's durable
   * function id that awaits this child's result, which the backend completion
   * hook keys the parent's durable child-result op to.
   *
   * The child run UUID is deterministic (`${parentWorkflowID}-child-${funcId}`),
   * so a parent replay POSTs the same UUID and the backend is idempotent on it
   * (mirrors createWorkflow's existing-UUID short-circuit + the durable enqueue
   * op recorded by the caller — see solidactions.ts startWorkflow).
   *
   * @param childWorkflowID    deterministic child run uuid
   * @param childWorkflowName  the child's registered workflow name (resolved to
   *                           a Workflow by slug within the parent's project)
   * @param input              serialized child input args
   * @param childResultFunctionID  the parent's durable funcID awaiting this child
   * @param identity           parent run identity (executorID = parent trigger
   *                           id; appId = parent ctx.app.appId; appVersion).
   *                           applicationID MUST equal the parent run's
   *                           application_id or the backend rejects the child
   *                           create with 403 (risk 2).
   */
  /**
   * Task 2.7 (FIX 1) — mark the PARENT trigger as waiting on a child before the
   * caller throws SuspensionRequired('child').
   *
   * This is the child-suspend analogue of recv's `POST /wait`: recv marks the
   * trigger `waiting` server-side BEFORE throwing SuspensionRequired('recv') so
   * the backend always re-pends a reliably-`waiting` trigger when the signal
   * arrives. The child path previously had NO server-side marking on the
   * SUSPEND (only at child-CREATE time, skipped on every parent replay), so a
   * parent that re-suspended on an unresolved child stayed in a non-`waiting`
   * state and the completion hook's re-pend never woke it → permanent stall for
   * parallel children (Codex lost-wakeup defect).
   *
   * Called by InvokeChildHandle.getResult() on EVERY suspension (including
   * replay) so the parent is always in the `waiting` re-pendable state the
   * backend's unconditional completion-hook re-pend can wake. It does NOT write
   * the child-result op (that is the backend completion hook's job) — it only
   * transitions the parent trigger. Same SuspensionRequired throw / exit-0 /
   * re-pend machinery as recv; NOT a new suspension mechanism.
   *
   * @param parentWorkflowID  the parent run uuid (the suspending workflow)
   * @param functionID        the parent's durable result funcID awaiting the
   *                          child (the same id keyed to the parent-result op)
   */
  async markWaitingOnChild(parentWorkflowID: string, functionID: number): Promise<void> {
    await this.invokeClient.post(`/runs/status/${encodeURIComponent(parentWorkflowID)}/child-wait`, {
      functionID,
    });
  }

  async enqueueChildWorkflow(
    childWorkflowID: string,
    childWorkflowName: string,
    input: string,
    childResultFunctionID: number,
    identity: { executorID: string; appId: string; appVersion: string },
  ): Promise<void> {
    await this.invokeClient.post(`/runs/status`, {
      workflowUUID: childWorkflowID,
      status: 'PENDING',
      workflowName: childWorkflowName,
      // executorId/applicationID/applicationVersion mirror initWorkflowStatus;
      // the backend additionally re-derives the parent/child auth LINK from the
      // authenticated bearer trigger (it does NOT trust these for that link —
      // see RunStatusController::ensureChildTrigger), but applicationID must
      // still match the parent run (risk 2).
      executorId: identity.executorID,
      applicationID: identity.appId,
      applicationVersion: identity.appVersion,
      input,
      createdAt: Date.now(),
      priority: 0,
      childResultFunctionID,
    });
  }
}
