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
  /**
   * Task 3.1 — subclass-visible logger reference (the base's `logger` is
   * private). Used by `captureVarsSnapshot` to warn-and-fall-back when a
   * legacy backend lacks the `/vars-snapshot` route.
   */
  private readonly invokeLogger: GlobalLogger;

  constructor(
    config: SolidActionsHttpConfig,
    identity: InvokeRunIdentity,
    logger: GlobalLogger,
    serializer: SolidActionsSerializer,
  ) {
    super(config, identity.executorID, identity.appVersion, logger, serializer);
    this.invokeLogger = logger;

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
   * Task 2.7 — atomic child-wait compare-and-set (Codex fix#2, DEFECT 1b).
   *
   * The child-suspend analogue of recv's `POST /wait`, but it closes a
   * lost-wakeup window recv does not have. The parent's getResult() reads the
   * child-result op; if absent it would suspend. But the child can complete in
   * the window BETWEEN that op-read and this /child-wait POST: the completion
   * writes the op and tries to re-pend, but the parent's one-shot process is
   * still running (trigger `started`, a running WorkerSession exists), so
   * DispatchTriggerToDaytona skips a duplicate dispatch — and a naive "always
   * mark waiting" here would then overwrite `started`→`waiting` with no
   * remaining re-dispatch → permanent stall.
   *
   * The backend now makes the op-resolved check and the →waiting transition
   * ONE atomic step (DB::transaction + lockForUpdate on the parent trigger),
   * keyed by the awaited child's RESULT functionID (passed here):
   *
   *   · `{ ready: true }`  — the child op is ALREADY resolved (happened-before
   *                          the suspend). The trigger was NOT marked
   *                          `waiting`. The caller MUST NOT suspend; it re-
   *                          reads the op and resolves/rethrows.
   *   · `{ ready: false }` — op unresolved; the trigger was transitioned to
   *                          `waiting` (only from a valid in-flight state). The
   *                          caller suspends; a completion that lands AFTER
   *                          this commit sees `waiting` and re-pends. No lost
   *                          window in either ordering.
   *
   * Same SuspensionRequired throw / exit-0 / re-pend machinery as recv; the
   * only addition is the atomic check + the `ready` signal.
   *
   * @param parentWorkflowID  the parent run uuid (the suspending workflow)
   * @param functionID        the parent's durable result funcID awaiting the
   *                          child (the exact id keyed to the parent-result op)
   * @returns `{ ready }` — `true` ⇒ child already complete, do NOT suspend.
   */
  async markWaitingOnChild(parentWorkflowID: string, functionID: number): Promise<{ ready: boolean }> {
    const resp = await this.invokeClient.post<{ ready?: boolean; status?: string }>(
      `/runs/status/${encodeURIComponent(parentWorkflowID)}/child-wait`,
      { functionID },
    );
    // Default to ready:false (suspend) if the field is absent — a missing
    // signal must fall back to the safe "suspend + wait for re-pend" path, not
    // a spurious "don't suspend" that could spin.
    return { ready: resp?.ready === true };
  }

  /**
   * Task 3.1 — write-once ctx.vars snapshot for replay determinism.
   *
   * The bug this fixes: a workflow that branches on `ctx.vars.X` BEFORE any
   * completed step. The first dispatch sees `vars.X='A'`, branches 'path-A',
   * and suspends. Between dispatches the adapter-supplied env var rotates to
   * `vars.X='B'`. A naive replay re-evaluates the branch and gets 'path-B' —
   * the cached step's recorded result then no longer matches the new branch,
   * causing divergence / corruption / wrong output.
   *
   * The fix: at run start, capture the adapter-supplied `ctx.vars` onto the
   * durable run record via a single POST that is write-once / first-write-wins
   * (atomicity contract mirrors the legacy `wfStatus.input` capture at
   * src/solidactions-executor.ts:407-446). Every dispatch — first or replay —
   * calls this method; the response carries the SNAPSHOT (what was actually
   * stored), which the caller substitutes for `ctx.vars` before running the
   * workflow body. On the first dispatch the supplied vars are stored and
   * returned; on every subsequent dispatch the body is ignored and the
   * previously-stored snapshot is returned, so the workflow body sees the
   * SAME `ctx.vars` across all dispatches regardless of how the adapter's
   * current values have drifted.
   *
   * Backward compatibility (legacy in-flight runs created before this method
   * landed): a 404 from the backend means the route is unimplemented — the
   * caller treats this as "no snapshot available, fall back to ctx-supplied
   * vars". This matches the legacy `recordOperationResult` swallow pattern
   * for routes that 404 on absent rows; the loss is the determinism guard for
   * that one in-flight run only, and the e2e parity gate (Task 3.3) catches
   * if the real backend ever rejects.
   *
   * @param workflowID  the run uuid (ctx.run.runUuid)
   * @param varsJson    SolidActionsJSON.stringify of the adapter-supplied
   *                    ctx.vars Record. On first dispatch this is what gets
   *                    stored; on replay it is ignored.
   * @returns           the stored snapshot (a JSON string parsed back into
   *                    a Record by the caller). `undefined` only when the
   *                    backend is legacy (404 from the route) — the caller
   *                    falls back to ctx.vars in that case.
   */
  async captureVarsSnapshot(workflowID: string, varsJson: string): Promise<string | undefined> {
    try {
      const resp = await this.invokeClient.post<{ vars: string | null }>(
        `/runs/status/${encodeURIComponent(workflowID)}/vars-snapshot`,
        { vars: varsJson },
      );
      return resp?.vars ?? undefined;
    } catch (err) {
      // Backward-compat: legacy backend (no /vars-snapshot route) → log + fall
      // back. ANY error here is non-fatal — the determinism guard is best-
      // effort on the SDK boundary; the worst case is the one in-flight legacy
      // run that lacks a snapshot reverts to the pre-fix behavior (the same
      // behavior it had before this task landed). The e2e parity gate
      // (Task 3.3) covers the real backend; jest covers the SDK contract.
      const msg = err instanceof Error ? err.message : String(err);
      this.invokeLogger.warn(`vars-snapshot unavailable for ${workflowID}: ${msg} (falling back to ctx.vars)`);
      return undefined;
    }
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
