import { SolidActionsContextualLogger } from './telemetry/logs';
import { IncomingHttpHeaders } from 'http';
import { ParsedUrlQuery } from 'querystring';
import { AsyncLocalStorage } from 'async_hooks';
import { SolidActionsInvalidWorkflowTransitionError } from './error';
import Koa from 'koa';
import { SolidActionsExecutor } from './solidactions-executor';

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

// Track if we've used the SolidActions_RUN_ID env var
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
  // If still no ID and this is the first top-level workflow, use SOLIDACTIONS_RUN_ID env var
  // This allows the runner to assign a specific UUID that links to run_triggers table
  if (!wfId && !envRunIdUsed) {
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
      logger: SolidActionsExecutor.globalInstance!.ctxLogger,
    },
    callback,
  );
}

/**
 * HTTPRequest includes useful information from http.IncomingMessage and parsed body,
 *   URL parameters, and parsed query string.
 * In essence, it is the serializable part of the request.
 */
export interface HTTPRequest {
  readonly headers?: IncomingHttpHeaders; // A node's http.IncomingHttpHeaders object.
  readonly rawHeaders?: string[]; // Raw headers.
  readonly params?: unknown; // Parsed path parameters from the URL.
  readonly body?: unknown; // parsed HTTP body as an object.
  readonly rawBody?: string; // Unparsed raw HTTP body string.
  readonly query?: ParsedUrlQuery; // Parsed query string.
  readonly querystring?: string; // Unparsed raw query string.
  readonly url?: string; // Request URL.
  readonly method?: string; // Request HTTP method.
  readonly ip?: string; // Request remote address.
  readonly requestID?: string; // Request ID. Gathered from headers or generated if missing.
}
