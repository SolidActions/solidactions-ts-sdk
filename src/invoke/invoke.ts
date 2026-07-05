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

import { deserializeError } from 'serialize-error';
import { SolidActionsWorkflowCancelledError } from '../error';
import { GlobalLogger } from '../telemetry/logs';
import { SolidActionsJSON } from '../serialization';
import { SolidActionsHttpConfig } from '../config';
import { InvokeSystemDatabase, SuspensionRequired } from './invoke-system-database';
import { runInScope, nextFunctionID, RuntimeParams, RuntimeScope } from './runtime-scope';
import {
  collectSecretStrings,
  redactVarsForSnapshot,
  rehydrateVarsFromSnapshot,
  scrubSecretsFromString,
} from './secret-redaction';
import { serializeErrorWithCause } from './serialize-error-with-cause';
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
function buildPrimitives(
  engine: InvokeSystemDatabase,
  workflowID: string,
  // Task 3.2: secret strings collected from ctx.vars (every ConnectionVar's
  // `key` and `proxyToken`). The step success/error paths scrub each
  // occurrence of these strings from the serialized payload before it
  // crosses the persistence boundary (POST /operations). Empty array → the
  // scrubber is a zero-cost no-op (no secret-bearing vars in this invoke).
  secretStrings: readonly string[],
): DurablePrimitives {
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
        // Task 3.2: scrub every known secret string from the serialized
        // step output before it crosses the persistence boundary. A step
        // that legitimately consumes `ctx.vars.X.key` should derive a
        // non-secret value to return; but if a workflow body accidentally
        // (or intentionally) puts a secret in its return value, the
        // serialized bytes the backend stores must not carry it.
        const outputJson = scrubSecretsFromString(SolidActionsJSON.stringify(output) ?? 'null', secretStrings);
        await engine.recordOperationResult(workflowID, functionID, stepName, true, startTime, {
          output: outputJson,
        });
        return output;
      } catch (err) {
        // Serialize with serialize-error so custom Error props survive suspend+replay.
        // Task 3.2: scrub the serialized error string too — a thrown error
        // could include a secret in its message (e.g. an HTTP client
        // serializing a request body into an error).
        const errorJson = scrubSecretsFromString(
          SolidActionsJSON.stringify(serializeErrorWithCause(err)) ?? 'null',
          secretStrings,
        );
        await engine.recordOperationResult(workflowID, functionID, stepName, true, startTime, {
          error: errorJson,
        });
        throw err;
      }
    },
  };

  return primitives;
}

/**
 * Run a workflow descriptor for one request.
 *
 * Mapping:
 *   - normal return ............................ { status: 'completed', output }
 *   - SuspensionRequired (ctx.sleep/ctx.recv) .. { status: 'suspended', reason }
 *   - SolidActionsWorkflowCancelledError ....... { status: 'cancelled' }
 *   - failure during engine init/health ........ { status: 'failed', phase: 'init' }
 *   - any other error from the body ............ { status: 'failed', phase: 'run' }
 *
 * Never calls process.exit; never lets an exception escape.
 */
export async function invoke<I, O>(workflow: WorkflowDescriptor<I, O>, ctx: InvokeCtx<I>): Promise<InvokeResult<O>> {
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
      // Thread the worker session id explicitly from ctx so the
      // X-Worker-Session-ID header never depends on a process.env read on the
      // invoke path (HttpClient's env fallback is legacy boot-only).
      workerSessionId: ctx.run.workerSessionId,
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

  // --- Phase: vars snapshot (Task 3.1 — replay determinism) --------------
  // Capture ctx.vars onto the durable run record write-once at run start, and
  // on every dispatch (including the first) substitute ctx.vars with the
  // returned SNAPSHOT. The first dispatch's POST writes & echoes back the
  // supplied vars; every subsequent dispatch ignores the body and returns the
  // previously-stored snapshot, so the workflow body sees identical ctx.vars
  // across all dispatches regardless of how the adapter-supplied current
  // values have drifted.
  //
  // This is the durable counterpart of the legacy `wfStatus.input` capture +
  // determinism check (src/solidactions-executor.ts:441-451); the legacy path
  // THROWS on a mismatch, the invoke path OVERRIDES with the snapshot —
  // equivalent enforcement, lighter contract (no user-visible error class,
  // the snapshot wins silently because for the invoke path there is no
  // "user-supplied input" — vars come from the runner's transport, not from
  // the user code).
  //
  // Backward-compat: a legacy backend without the /vars-snapshot route
  // returns 404; captureVarsSnapshot logs a warn and resolves to undefined,
  // and we fall back to the ctx-supplied vars (pre-fix behavior for that one
  // in-flight legacy run — no regression, no crash).
  //
  // Errors here are isolated from the workflow body: any unexpected throw
  // from captureVarsSnapshot itself is swallowed in the method (logged as
  // warn). A failure to capture must NOT phase-init-fail the run — the
  // legacy run-record write path also swallows transient persistence blips.
  try {
    // Task 3.2: redact ConnectionVar secrets BEFORE the snapshot crosses the
    // persistence boundary. Each ConnectionVar in ctx.vars is replaced with
    // a RedactedConnectionVarRef carrying only the var name + non-secret
    // proxyUrl. The plaintext `key` and `proxyToken` never enter `varsJson`
    // and therefore never enter the durable run record.
    const redactedVars = redactVarsForSnapshot(ctx.vars);
    const varsJson = SolidActionsJSON.stringify(redactedVars);
    const snapshot = await engine.captureVarsSnapshot(workflowID, varsJson);
    if (snapshot !== undefined) {
      // SNAPSHOT WINS for non-secret vars (Task 3.1). For secret fields of
      // a ConnectionVar (`key`, `proxyToken`), the snapshot carries only a
      // reference; re-hydrate those from the adapter-supplied live ctx.vars
      // by name. The runner re-injects the live connection per dispatch
      // (the connection store is the source of truth at runtime); the
      // workflow body sees a fully-populated ConnectionVar indistinguishable
      // from the first dispatch's view. Secret rotation between dispatches
      // is tolerated divergence (the connection store, not the SDK, owns
      // that contract).
      const parsed = SolidActionsJSON.parse(snapshot) as Record<string, unknown>;
      const rehydrated = rehydrateVarsFromSnapshot(parsed, ctx.vars);
      ctx = { ...ctx, vars: Object.freeze(rehydrated) as InvokeCtx<I>['vars'] };
    }
    // snapshot === undefined → backend lacks the route (legacy / in-flight
    // run created before this task landed); leave ctx.vars as-is.
  } catch {
    // Defense in depth: captureVarsSnapshot already swallows + logs, but
    // shield the workflow from any unexpected parse/stringify failure.
  }

  // --- Phase: run --------------------------------------------------------
  // Per-invoke runtime identity — sourced strictly from ctx (Task 2.4a: this is
  // now THE identity for the workflow path; there is no globalParams to fall
  // back to). Carried in the ALS scope so concurrent invokes never share it.
  const runtimeParams: RuntimeParams = {
    workflowID,
    executorID: String(ctx.run.triggerId),
    appId: ctx.app.appId,
    appVersion: ctx.app.appVersion,
    // Task 2.6: public API base URL, ctx-sourced (never process.env), so the
    // bridged SolidActions.getSignalUrls can build signal URLs on the invoke
    // path without reading SOLIDACTIONS_API_URL/APP_URL.
    apiUrl: ctx.api.url,
    functionIDCounter: 0,
  };
  // Build the durable primitives once; attach to ctx (for descriptor bodies that
  // take ctx) AND to the scope (Task 2.3: so legacy SolidActions.runStep/sleepms
  // free-functions delegate to these EXACT closures — single source of truth).
  // Task 3.2: collect plaintext secret strings (key + proxyToken of every
  // ConnectionVar) AFTER snapshot re-hydration so any rotated secret from
  // the live ctx.vars is included. The step primitive scrubs these from
  // serialized step outputs/errors before they cross the persistence
  // boundary.
  const secretStrings = collectSecretStrings(ctx.vars);
  const primitives = buildPrimitives(engine, workflowID, secretStrings);
  const scope: RuntimeScope = { executor: engine, runtimeParams, primitives };

  try {
    const ctxWithPrimitives = Object.assign(ctx, primitives);
    const output = await runInScope(scope, () => workflow.run(ctxWithPrimitives));
    return { status: 'completed', output };
  } catch (error) {
    if (error instanceof SuspensionRequired) {
      return { status: 'suspended', reason: error.reason };
    }
    // Task 2.8: a cancelled workflow surfaces SolidActionsWorkflowCancelledError
    // (thrown by getOperationResultAndThrowIfCancelled when the run row is
    // CANCELLED — including the sleep/recv resume path: durableSleepms calls it
    // before scheduling). Detect it BEFORE the generic failed mapping so the
    // one-shot path can write StatusString.CANCELLED, mirroring the legacy
    // executor's explicit cancelled-self branch (solidactions-executor.ts:606-611).
    // Must precede the failed mapping — a CancelledError is NOT a failure.
    if (error instanceof SolidActionsWorkflowCancelledError) {
      return { status: 'cancelled' };
    }
    return { status: 'failed', error, phase: 'run' };
  }
}
