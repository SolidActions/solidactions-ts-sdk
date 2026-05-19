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

    const resolve = (recorded: { output?: string | null; error?: string | null }): R => {
      if (recorded.error) {
        // Child failed: rethrow with serialize-error so custom Error props
        // (code, statusCode, …) survive the suspend+replay round-trip — the
        // parent observes the failure, never a silent stall (risk 6). The
        // backend GUARANTEES recorded.error is a non-null serialized error on
        // failure even on the infra-fallback path (TriggerCompletionService::
        // notifyParentOfChildCompletion), so this always rethrows and the
        // parent fails fast instead of stalling.
        throw deserializeError(SolidActionsJSON.parse(recorded.error));
      }
      return SolidActionsJSON.parse(recorded.output ?? 'null') as R;
    };

    const recorded = await this.engine.getOperationResultAndThrowIfCancelled(this.parentWorkflowID, funcId);
    if (recorded) {
      // Replay path: the child-result op is already durable — resolve/rethrow.
      return resolve(recorded);
    }

    // Child-result op ABSENT on this read. Before suspending, do the atomic
    // child-wait compare-and-set (Codex fix#2, DEFECT 1b). It either marks the
    // parent `waiting` (op still unresolved → safe to suspend; a later
    // completion sees `waiting` and re-pends) OR tells us the child ALREADY
    // completed in the op-read↔child-wait window (`ready:true`) — in which
    // case suspending would strand an in-flight parent with no remaining
    // re-dispatch (the lost-wakeup permanent stall).
    const { ready } = await this.engine.markWaitingOnChild(this.parentWorkflowID, funcId);

    if (ready) {
      // The CAS guarantees the op was committed-resolved BEFORE it returned
      // ready:true. Re-read ONCE (bounded — no loop): resolve/rethrow instead
      // of suspending. If, defensively, the op is still not visible (it must
      // be, per the CAS invariant), fall through to the safe suspend path so
      // the next re-pend/replay converges — never an infinite re-read.
      const afterReady = await this.engine.getOperationResultAndThrowIfCancelled(this.parentWorkflowID, funcId);
      if (afterReady) {
        return resolve(afterReady);
      }
    }

    // Genuinely unresolved (ready:false) — the parent is now `waiting`
    // server-side; suspend via the SAME throw / exit-0 / re-pend machinery as
    // recv/sleep (not a new mechanism). The completion-hook re-pend wakes the
    // reliably-`waiting` parent; replay re-reads the op and resolves.
    throw new SuspensionRequired('child');
  }
}

/**
 * Spawn a child workflow under the current invoke scope, by registered name.
 *
 * Factored out of `invokeStartChildWorkflow` (T2 launcher rework) so the
 * descriptor/string code path can dispatch directly without going through the
 * function-Proxy form — `startWorkflow(workflowDescriptor)(input)` and
 * `startWorkflow('child-name')(input)` are not function-callable targets, so
 * they bypass the Proxy entirely. The function/object Proxy form below still
 * routes through this same `spawn` so child dispatch is one mechanism.
 *
 * MUST be called with an active invoke scope — callers guard via
 * `getCurrentScope()` before delegating, exactly like `invokeStartChildWorkflow`.
 */
async function spawnChildByName(childName: string, args: unknown[]): Promise<InvokeChildHandle<unknown>> {
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
}

/**
 * Invoke-path implementation of `SolidActions.startWorkflow(target)(args)` for
 * function-callable targets. Returns a Proxy with the same call/method shape
 * as the legacy startWorkflow so `startWorkflow(fn)(input)` and
 * `startWorkflow(obj).method(input)` both yield an InvokeChildHandle.
 *
 * Descriptor + string targets bypass this Proxy form (they are not callable)
 * and call `invokeStartChildWorkflowByName` directly instead.
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

  const handler: ProxyHandler<object> = {
    apply(t, _thisArg, args) {
      return spawnChildByName(resolveName(t), args);
    },
    get(_t, p) {
      return (...args: unknown[]) => spawnChildByName(resolveName(target, p), args);
    },
  };

  return new Proxy(target, handler);
}

/**
 * Invoke-path child-workflow dispatch for non-function targets — a
 * {@link WorkflowDescriptor} returned by `defineWorkflow`, or a bare string
 * registered name. Returns a callable `(args) => Promise<InvokeChildHandle>`,
 * matching the calling convention `startWorkflow(target)(args)` so the same
 * external shape works for descriptor/string + function/object targets.
 *
 * `childName` is the already-resolved registered name (the caller does the
 * registry lookup in `solidactions.ts`'s invoke-scope branch so the error path
 * sees the supplied identifier).
 */
export function invokeStartChildWorkflowByName(childName: string): (...args: unknown[]) => Promise<InvokeChildHandle<unknown>> {
  const scope = getCurrentScope();
  if (!scope) {
    throw new Error('invokeStartChildWorkflowByName called with no active invoke scope');
  }
  return (...args: unknown[]) => spawnChildByName(childName, args);
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
