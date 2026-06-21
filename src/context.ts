import { SolidActionsContextualLogger } from './telemetry/logs';
import { ParsedUrlQuery } from 'querystring';
import { AsyncLocalStorage } from 'async_hooks';
import { SolidActionsInvalidWorkflowTransitionError } from './error';
import Koa from 'koa';
import { SolidActionsExecutor } from './solidactions-executor';
// Type/value import of the invoke ALS accessor. runtime-scope only type-imports
// the heavy engine classes, so this pulls no runtime import cycle (it is already
// a static import in src/solidactions.ts).
import { getCurrentScope } from './invoke/runtime-scope';

export interface StepStatus {
  stepID: number;
  currentAttempt?: number;
  maxAttempts?: number;
}

export interface SolidActionsContextOptions {
  idAssignedForNextWorkflow?: string;
  queueAssignedForWorkflows?: string;
  logger?: SolidActionsContextualLogger;
  authenticatedUser?: string;
  authenticatedRoles?: string[];
  assumedRole?: string;
  request?: object;
  operationType?: string; // A custom helper for users to set a operation type of their choice. Intended for functions setting a pctx to run SolidActions operations from.
  operationCaller?: string; // This is made to pass through the operationName to SolidActions contexts, and potentially the caller span name.
  workflowTimeoutMS?: number | null;
}

export interface SolidActionsLocalCtx extends SolidActionsContextOptions {
  parentCtx?: SolidActionsLocalCtx;
  workflowId?: string;
  curWFFunctionId?: number; // If currently in a WF, the current call number / ID
  presetID?: boolean;
  deadlineEpochMS?: number;
  inRecovery?: boolean;
  curStepFunctionId?: number; // If currently in a step, its function ID
  stepStatus?: StepStatus; // If currently in a step, its public status object
  curTxFunctionId?: number; // If currently in a tx, its function ID
  koaContext?: Koa.Context;
}

function isWithinWorkflowCtx(ctx: SolidActionsLocalCtx) {
  if (ctx.workflowId === undefined) return false;
  return true;
}

function isInStepCtx(ctx: SolidActionsLocalCtx) {
  if (ctx.workflowId === undefined) return false;
  if (ctx.curStepFunctionId) return true;
  return false;
}

function isInTxnCtx(ctx: SolidActionsLocalCtx) {
  if (ctx.workflowId === undefined) return false;
  if (ctx.curTxFunctionId) return true;
  return false;
}

export function isInWorkflowCtx(ctx: SolidActionsLocalCtx) {
  if (!isWithinWorkflowCtx(ctx)) return false;
  if (isInStepCtx(ctx)) return false;
  if (isInTxnCtx(ctx)) return false;
  return true;
}

const asyncLocalCtx = new AsyncLocalStorage<SolidActionsLocalCtx>();

export function getCurrentContextStore(): SolidActionsLocalCtx | undefined {
  return asyncLocalCtx.getStore();
}

// Track if we've used the legacy SOLIDACTIONS_RUN_ID env var (boot-only fallback).
// Module-local to this legacy context; the invoke() path never reaches this code.
let envRunIdUsed = false;

export function getNextWFID(assignedID?: string) {
  let wfId = assignedID;
  if (!wfId) {
    const pctx = getCurrentContextStore();
    const nextID = pctx?.idAssignedForNextWorkflow;
    if (nextID) {
      wfId = nextID;
      pctx.idAssignedForNextWorkflow = undefined;
    }
  }
  // Prefer the active invoke ALS scope's workflow id when present: under the
  // one-shot run()->invoke() bridge a legacy-registered body executes inside an
  // invoke scope, so the run id is the scope's (ctx-derived) workflowID — never
  // a process.env read on the workflow path.
  if (!wfId) {
    const scopeWfId = getCurrentScope()?.runtimeParams.workflowID;
    if (scopeWfId) {
      wfId = scopeWfId;
    }
  }
  // If still no ID and this is the first top-level workflow, fall back to the
  // legacy SOLIDACTIONS_RUN_ID env var. This is the legacy runner's run-id
  // injection (links to the run_triggers table) and applies ONLY to the legacy
  // boot path; the invoke() workflow path resolved its id from scope above.
  if (!wfId && !envRunIdUsed) {
    /* boot-only */ // legacy runner run-id transport; invoke()'s run id comes from the ALS scope (ctx.run.runUuid)
    const envRunId = process.env.SOLIDACTIONS_RUN_ID;
    if (envRunId) {
      wfId = envRunId;
      envRunIdUsed = true;
    }
  }
  return wfId;
}

export function functionIDGetIncrement(): number {
  const pctx = getCurrentContextStore();
  if (!pctx)
    throw new SolidActionsInvalidWorkflowTransitionError(`Attempt to get a call ID number outside of a workflow`);
  if (!isInWorkflowCtx(pctx))
    throw new SolidActionsInvalidWorkflowTransitionError(
      `Attempt to get a call ID number in a workflow that is already in a call`,
    );
  if (pctx.curWFFunctionId === undefined) pctx.curWFFunctionId = 0;
  return pctx.curWFFunctionId++;
}

export function functionIDGet(): number {
  const pctx = getCurrentContextStore();
  if (!pctx)
    throw new SolidActionsInvalidWorkflowTransitionError(`Attempt to get a call ID number outside of a workflow`);
  if (!isInWorkflowCtx(pctx))
    throw new SolidActionsInvalidWorkflowTransitionError(
      `Attempt to get a call ID number in a workflow that is already in a call`,
    );
  if (pctx.curWFFunctionId === undefined) pctx.curWFFunctionId = 0;
  return pctx.curWFFunctionId;
}

export async function runWithTopContext<R>(ctx: SolidActionsLocalCtx, callback: () => Promise<R>): Promise<R> {
  return await asyncLocalCtx.run(ctx, callback);
}

export async function runWithParentContext<R>(
  pctx: SolidActionsLocalCtx | undefined,
  ctx: SolidActionsLocalCtx,
  callback: () => Promise<R>,
): Promise<R> {
  return await asyncLocalCtx.run(
    {
      ...pctx,
      ...ctx,
      parentCtx: pctx,
    },
    callback,
  );
}

export async function runInStepContext<R>(
  pctx: SolidActionsLocalCtx,
  stepID: number,
  maxAttempts: number | undefined,
  currentAttempt: number | undefined,
  callback: () => Promise<R>,
) {
  // Check we are in a workflow context and not in a step / transaction already
  if (!pctx) throw new SolidActionsInvalidWorkflowTransitionError();
  if (!isInWorkflowCtx(pctx)) throw new SolidActionsInvalidWorkflowTransitionError();

  const stepStatus: StepStatus = {
    stepID: stepID,
    currentAttempt: currentAttempt,
    maxAttempts: currentAttempt ? maxAttempts : undefined,
  };

  return await runWithParentContext(
    pctx,
    {
      stepStatus: stepStatus,
      curStepFunctionId: stepID,
      parentCtx: pctx,
      // Task 2.4c: legacy run() step-context logger. This path is LEGACY-only —
      // invoke() never calls runInStepContext (it uses src/invoke/runtime-scope
      // + its own GlobalLogger). The SolidActionsExecutor.globalInstance
      // singleton coupling is retired with the legacy wrapper in Task 2.4c, not
      // here (2.4a deletes globalParams/process.env identity, not globalInstance).
      logger: SolidActionsExecutor.globalInstance!.ctxLogger,
    },
    callback,
  );
}

/**
 * HTTPRequest is the serializable portion of an HTTP request used for legacy
 * context-store–based API handlers (e.g. `SolidActions.getRequest()`).
 *
 * NOTE: This type is NOT `ctx.input`. For webhook triggers, `ctx.input` is the
 * parsed request body/query only — request headers and raw body are never
 * populated on the invoke path and are intentionally absent from this type.
 * Do not cast `ctx.input` to `HTTPRequest` or add `headers`/`rawBody` to your
 * webhook input interface; those fields will always be undefined.
 */
export interface HTTPRequest {
  readonly params?: unknown; // Parsed path parameters from the URL.
  readonly body?: unknown; // Parsed HTTP body as an object.
  readonly query?: ParsedUrlQuery; // Parsed query string.
  readonly querystring?: string; // Unparsed raw query string.
  readonly url?: string; // Request URL.
  readonly method?: string; // Request HTTP method.
  readonly ip?: string; // Request remote address.
  readonly requestID?: string; // Request ID. Gathered from headers or generated if missing.
}
