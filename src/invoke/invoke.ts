/**
 * invoke() — run a single workflow descriptor for one request and return an
 * InvokeResult, never exiting the process and never letting an exception escape.
 *
 * Architecture (read before changing):
 *
 *   The per-request "executor" here is InvokeSystemDatabase, NOT the legacy
 *   SolidActionsExecutor class. This is a deliberate, documented deviation from
 *   the literal "construct a SolidActionsExecutor" wording, forced by hard
 *   constraints the legacy class cannot satisfy on the invoke path:
 *
 *     - SolidActionsExecutor's constructor unconditionally runs
 *       `this.executorID = globalParams.executorID` (field initializer) and
 *       `SolidActionsExecutor.globalInstance = this`. Both are forbidden here
 *       ("NEVER globalParams", "NEVER SolidActionsExecutor.globalInstance") and
 *       there is no constructor option to suppress either.
 *     - executor.init() (non-debug) calls recoverPendingWorkflows(), which reads
 *       globalParams.appVersion and POSTs /workflows/pending.
 *     - executor.internalWorkflow() requires a *registered* function and bakes
 *       globalParams.executorID/appVersion/appID into the workflow status;
 *       defineWorkflow() produces a plain { run } descriptor by design.
 *
 *   InvokeSystemDatabase was built by the prior task precisely as the
 *   per-request engine: identity injected explicitly (no globals), suspends by
 *   throwing SuspensionRequired instead of process.exit. It IS the fresh
 *   per-request executor the architecture intends; the legacy class is what
 *   Phase 2 deletes. All identity comes strictly from `ctx` — no process.env or
 *   module-global reads on this path.
 *
 *   Durable primitives are attached onto the ctx object and delegate to the
 *   scoped InvokeSystemDatabase using an explicit workflow id (ctx.run.runUuid)
 *   and a per-invoke function-id counter held in the ALS scope (runtime-scope).
 *   sleep/recv go through InvokeSystemDatabase so they throw SuspensionRequired;
 *   step/send are correct minimal delegations (not exercised by Task 1.3's
 *   tests — see notes on each).
 */

import { deserializeError, serializeError } from 'serialize-error';
import { GlobalLogger } from '../telemetry/logs';
import { SolidActionsJSON } from '../serialization';
import { SolidActionsHttpConfig } from '../config';
import { InvokeSystemDatabase, SuspensionRequired } from './invoke-system-database';
import { runInScope, nextFunctionID, RuntimeParams, RuntimeScope } from './runtime-scope';
import type { InvokeCtx, InvokeResult, WorkflowDescriptor, DurablePrimitives } from './types';

/**
 * Attach the durable primitives onto `ctx`, delegating to the scoped
 * per-request engine. Identity (workflow id) comes from `ctx.run.runUuid`;
 * durable ordering comes from the ALS scope's function-id counter.
 *
 * - sleep/recv route through InvokeSystemDatabase, which posts the schedule then
 *   throws SuspensionRequired (caught by invoke() and mapped to 'suspended').
 * - step: minimal delegation — record-or-replay the result via the engine's
 *   operation-result API so a re-invocation after suspension is idempotent. Not
 *   exercised by Task 1.3 tests; safe because it uses only public engine
 *   methods with explicit ids and never touches legacy context/globals.
 * - send: minimal delegation straight to the engine's send(). Not exercised by
 *   Task 1.3 tests; safe for the same reason.
 */
function attachPrimitives<I>(
  ctx: InvokeCtx<I>,
  engine: InvokeSystemDatabase,
  workflowID: string,
): InvokeCtx<I> & DurablePrimitives {
  const primitives: DurablePrimitives = {
    // MINIMAL 1.3: sleep delegates directly to engine.durableSleepms; no retry/deadline policy yet.
    sleep: (ms: number): Promise<void> => engine.durableSleepms(workflowID, nextFunctionID(), ms),

    recv: async <T = unknown>(topic?: string): Promise<T> => {
      // MINIMAL 1.3: recv delegates to engine.recv; no timeout/cancellation handling beyond what the engine provides.
      const functionID = nextFunctionID();
      const timeoutFunctionID = nextFunctionID();
      const raw = await engine.recv(workflowID, functionID, timeoutFunctionID, topic);
      return SolidActionsJSON.parse(raw) as T;
    },

    send: (topic: string, payload: unknown): Promise<void> => {
      const functionID = nextFunctionID();
      // MINIMAL 1.3: destinationID == workflowID (self-send only). Task 2.x: thread real cross-workflow target from cfg.
      return engine.send(workflowID, functionID, workflowID, SolidActionsJSON.stringify(payload), topic);
    },

    step: async <T>(fn: () => T | Promise<T>, cfg?: { name?: string }): Promise<T> => {
      const functionID = nextFunctionID();
      // MINIMAL 1.3: step is minimal record-or-replay; full retry/timeout policy comes in Task 2.x.
      const stepName = cfg?.name || fn.name || '<step>';

      // Replay: if this step already recorded a result, return it instead of
      // re-running the function (idempotency across re-invocation).
      const recorded = await engine.getOperationResultAndThrowIfCancelled(workflowID, functionID);
      if (recorded) {
        if (recorded.error) {
          // Deserialize using serialize-error so custom Error props (e.g. code, statusCode) survive replay.
          throw deserializeError(SolidActionsJSON.parse(recorded.error));
        }
        return SolidActionsJSON.parse(recorded.output ?? null) as T;
      }

      const startTime = Date.now();
      try {
        const output = await fn();
        await engine.recordOperationResult(workflowID, functionID, stepName, true, startTime, {
          output: SolidActionsJSON.stringify(output),
        });
        return output;
      } catch (err) {
        // Serialize with serialize-error so custom Error props survive suspend+replay.
        await engine.recordOperationResult(workflowID, functionID, stepName, true, startTime, {
          error: SolidActionsJSON.stringify(serializeError(err)),
        });
        throw err;
      }
    },
  };

  return Object.assign(ctx, primitives);
}

/**
 * Run a workflow descriptor for one request.
 *
 * Mapping:
 *   - normal return ............................ { status: 'completed', output }
 *   - SuspensionRequired (ctx.sleep/ctx.recv) .. { status: 'suspended', reason }
 *   - failure during engine init/health ........ { status: 'failed', phase: 'init' }
 *   - any other error from the body ............ { status: 'failed', phase: 'run' }
 *
 * Never calls process.exit; never lets an exception escape.
 */
export async function invoke<I, O>(
  workflow: WorkflowDescriptor<I, O>,
  ctx: InvokeCtx<I>,
): Promise<InvokeResult<O>> {
  // --- Phase: init -------------------------------------------------------
  // Construct a FRESH per-request engine. Identity is taken strictly from ctx
  // (ctx.run / ctx.app / ctx.api) — no globalParams, no SolidActionsExecutor
  // global instance, no process.env reads.
  let engine: InvokeSystemDatabase;
  const workflowID = ctx.run.runUuid;
  try {
    const httpConfig: SolidActionsHttpConfig = {
      apiUrl: ctx.api.url,
      apiKey: ctx.api.key,
    };
    const logger = new GlobalLogger();
    engine = new InvokeSystemDatabase(
      httpConfig,
      { executorID: String(ctx.run.triggerId), appVersion: ctx.app.appVersion },
      logger,
      SolidActionsJSON,
    );
    // Health check — equivalent of the legacy executor.init() connectivity
    // probe. A failure here is BEFORE the workflow body runs => phase 'init'.
    await engine.init();
  } catch (error) {
    return { status: 'failed', error, phase: 'init' };
  }

  // --- Phase: run --------------------------------------------------------
  // runtimeParams identity fields are placeholders for Task 2.4 ALS convergence; only functionIDCounter is read in 1.3 (via nextFunctionID).
  const runtimeParams: RuntimeParams = {
    workflowID,
    executorID: String(ctx.run.triggerId),
    appVersion: ctx.app.appVersion,
    functionIDCounter: 0,
  };
  const scope: RuntimeScope = { executor: engine, runtimeParams };

  try {
    const ctxWithPrimitives = attachPrimitives(ctx, engine, workflowID);
    const output = await runInScope(scope, () => workflow.run(ctxWithPrimitives));
    return { status: 'completed', output };
  } catch (error) {
    if (error instanceof SuspensionRequired) {
      return { status: 'suspended', reason: error.reason };
    }
    return { status: 'failed', error, phase: 'run' };
  }
}
