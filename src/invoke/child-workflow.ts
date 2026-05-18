/**
 * Task 2.7 — child-workflow dispatch under the one-shot invoke() path.
 *
 * Legacy `SolidActions.startWorkflow(child)(input)` ran the child INLINE in a
 * long-lived process and `childHandle.getResult()` blocking-polled. Neither
 * works one-shot: the process exits at every suspend. This module bridges
 * startWorkflow/getResult onto the SAME durable-op + suspend machinery sleep
 * and recv already use (Task 2.6 pattern: getCurrentScope() → scope.executor +
 * ALS function ids; never legacy globals).
 *
 * Mechanism (see docs/superpowers/notes/2026-05-18-task-2.7-child-workflow-design.md):
 *
 *   startWorkflow(child)(input):
 *     - consume ONE durable funcId (enqueueFuncId) — stable across parent
 *       replay, so the child run UUID is deterministic.
 *     - replay guard: if the durable enqueue op (parentWf, enqueueFuncId) is
 *       already recorded → reuse its childWorkflowID, do NOT re-enqueue
 *       (idempotency, risk 1; mirrors solidactions-executor.ts:453).
 *     - else: POST the child create (the existing /runs/status endpoint the SDK
 *       already calls for a child, now also creating the child RunTrigger
 *       backend-side) then record the durable enqueue op carrying the child id.
 *
 *   childHandle.getResult():
 *     - consume a SECOND durable funcId (resultFuncId) — matches the legacy
 *       startWf+getRes two-id pattern (solidactions.ts #getWorkflowInvoker).
 *     - read the PARENT-keyed durable child-result op (parentWf, resultFuncId)
 *       the backend completion hook writes when the child finishes:
 *         · present + output → parse & return (replay path)
 *         · present + error  → rethrow the child's error (risk 6)
 *         · absent            → child not done → throw SuspensionRequired('child')
 *           (same throw→exit-0→re-pend→re-invoke→replay machinery as recv)
 */

import { deserializeError } from 'serialize-error';
import { SolidActionsJSON } from '../serialization';
import type { WorkflowHandle, WorkflowStatus } from '../workflow';
import type { InvokeSystemDatabase } from './invoke-system-database';
import { SuspensionRequired } from './invoke-system-database';
import { getCurrentScope, nextFunctionID } from './runtime-scope';

/**
 * The handle returned by `SolidActions.startWorkflow(child)(input)` on the
 * invoke path. `workflowID` is available immediately (deterministic) so a
 * parent can read it / do parallel work before awaiting (multistep-parent
 * shape). `getResult()` is the durable read-or-suspend join point.
 */
export class InvokeChildHandle<R> implements WorkflowHandle<R> {
  constructor(
    private readonly engine: InvokeSystemDatabase,
    private readonly parentWorkflowID: string,
    readonly childWorkflowID: string,
  ) {}

  get workflowID(): string {
    return this.childWorkflowID;
  }

  async getStatus(): Promise<WorkflowStatus | null> {
    // The child is its own backend run; read its status row directly. A missing
    // row (child not yet created its RunStatus) reads as null — callers that
    // need the result use getResult(), which suspends until it exists.
    return (await this.engine.getWorkflowStatus(this.childWorkflowID)) as unknown as WorkflowStatus | null;
  }

  async getWorkflowInputs<T extends unknown[]>(): Promise<T> {
    const status = await this.engine.getWorkflowStatus(this.childWorkflowID);
    return SolidActionsJSON.parse(status?.input ?? 'null') as T;
  }

  /**
   * Read the parent-keyed durable child-result op. Present → return/rethrow
   * (replay). Absent → child not done → suspend the parent (the backend
   * completion hook writes the op THEN re-pends the parent, so a re-invoke
   * replays and this read resolves).
   */
  async getResult(resultFuncId?: number): Promise<R> {
    const funcId = resultFuncId ?? nextFunctionID();
    const recorded = await this.engine.getOperationResultAndThrowIfCancelled(this.parentWorkflowID, funcId);

    if (recorded) {
      if (recorded.error) {
        // Child failed: rethrow with serialize-error so custom Error props
        // (code, statusCode, …) survive the suspend+replay round-trip — the
        // parent observes the failure, never a silent stall (risk 6). The
        // backend GUARANTEES recorded.error is a non-null serialized error on
        // failure even on the infra-fallback path (TriggerCompletionService::
        // notifyParentOfChildCompletion), so this branch always rethrows and
        // the parent fails fast instead of stalling.
        throw deserializeError(SolidActionsJSON.parse(recorded.error));
      }
      return SolidActionsJSON.parse(recorded.output ?? 'null') as R;
    }

    // Child not finished — suspend the parent. FIX 1 (lost-wakeup): mark the
    // parent `waiting` server-side FIRST (the child-suspend analogue of recv's
    // POST /wait), on EVERY suspension including replay, so the backend's
    // completion-hook re-pend always wakes a reliably-`waiting` parent. Without
    // this, a parent that re-suspended on an unresolved sibling child stayed in
    // a non-`waiting` state and the later completion never re-pended it →
    // permanent stall for parallel children. SAME SuspensionRequired throw /
    // exit-0 / re-pend machinery as recv/sleep — not a new mechanism.
    await this.engine.markWaitingOnChild(this.parentWorkflowID, funcId);
    throw new SuspensionRequired('child');
  }
}

/**
 * Invoke-path implementation of `SolidActions.startWorkflow(target)(args)`.
 * Returns a Proxy with the same call/method shape as the legacy startWorkflow
 * so `startWorkflow(fn)(input)` and `startWorkflow(obj).method(input)` both
 * yield an InvokeChildHandle.
 *
 * @param resolveName  maps the proxied target/method to the child's registered
 *                      workflow name (the backend resolves it to a Workflow by
 *                      slug within the parent's project).
 */
export function invokeStartChildWorkflow(
  resolveName: (target: unknown, prop?: string | symbol) => string,
  target: object,
): unknown {
  const scope = getCurrentScope();
  if (!scope) {
    // Caller must guard with getCurrentScope() before delegating here.
    throw new Error('invokeStartChildWorkflow called with no active invoke scope');
  }

  const spawn = async (childName: string, args: unknown[]): Promise<InvokeChildHandle<unknown>> => {
    const s = getCurrentScope();
    if (!s) {
      throw new Error('invoke scope lost before child spawn');
    }
    const engine = s.executor;
    const parentWorkflowID = s.runtimeParams.workflowID;

    // ONE durable funcId for the enqueue, consumed at call time so the child
    // run UUID is deterministic across parent replay (idempotency anchor).
    const enqueueFuncId = nextFunctionID();
    const childWorkflowID = `${parentWorkflowID}-child-${enqueueFuncId}`;

    // The result funcId is allocated NOW (right after the enqueue id) and
    // captured in the handle so it is stable regardless of when/how often
    // getResult() is called — matching the legacy startWf+getRes two-id
    // ordering (solidactions.ts #getWorkflowInvoker:2092-2093).
    const resultFuncId = nextFunctionID();

    // Replay guard (risk 1): if the durable enqueue op already exists, the
    // child was enqueued on a prior parent run — reuse it, do NOT re-enqueue.
    const recordedEnqueue = await engine.getOperationResultAndThrowIfCancelled(parentWorkflowID, enqueueFuncId);
    if (recordedEnqueue) {
      if (recordedEnqueue.error) {
        throw deserializeError(SolidActionsJSON.parse(recordedEnqueue.error));
      }
      const existingChildId = recordedEnqueue.childWorkflowID ?? childWorkflowID;
      return new InvokeChildHandleWithResultId(engine, parentWorkflowID, existingChildId, resultFuncId);
    }

    // First parent run: create the child backend run (its own container via the
    // pending child RunTrigger the backend creates) then record the durable
    // enqueue op keyed (parentWf, enqueueFuncId) carrying the child id. Order:
    // create FIRST, then record — mirrors solidactions-executor.ts:483-494 so a
    // crash between them re-creates idempotently (backend short-circuits the
    // duplicate UUID) rather than recording a child that was never created.
    await engine.enqueueChildWorkflow(
      childWorkflowID,
      childName,
      SolidActionsJSON.stringify(args.length === 1 ? args[0] : args),
      resultFuncId,
      {
        executorID: s.runtimeParams.executorID,
        appId: s.runtimeParams.appId,
        appVersion: s.runtimeParams.appVersion,
      },
    );
    await engine.recordOperationResult(
      parentWorkflowID,
      enqueueFuncId,
      'SolidActions.startWorkflow',
      true,
      Date.now(),
      { childWorkflowID },
    );

    return new InvokeChildHandleWithResultId(engine, parentWorkflowID, childWorkflowID, resultFuncId);
  };

  const handler: ProxyHandler<object> = {
    apply(t, _thisArg, args) {
      return spawn(resolveName(t), args);
    },
    get(_t, p) {
      return (...args: unknown[]) => spawn(resolveName(target, p), args);
    },
  };

  return new Proxy(target, handler);
}

/**
 * InvokeChildHandle variant that pins the result funcId at construction (it was
 * allocated alongside the enqueue id at spawn time). getResult() therefore
 * always reads the SAME parent-keyed op regardless of call count, so a parent
 * that does `const h = startWorkflow(c)(x); ...; await h.getResult()` reads a
 * deterministic op id across replay.
 */
class InvokeChildHandleWithResultId<R> extends InvokeChildHandle<R> {
  constructor(
    engine: InvokeSystemDatabase,
    parentWorkflowID: string,
    childWorkflowID: string,
    private readonly pinnedResultFuncId: number,
  ) {
    super(engine, parentWorkflowID, childWorkflowID);
  }

  override getResult(): Promise<R> {
    return super.getResult(this.pinnedResultFuncId);
  }
}
