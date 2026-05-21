// src/invoke/run-status-lifecycle.ts
//
// Shared durable run-status lifecycle, extracted from SolidActions.run()
// (Task A.1, Blaxel resident MVP). Both the one-shot run() path AND the
// resident runResident() path create the run-status row BEFORE invoke() and
// report terminal/suspend state AFTER, hitting the SAME Laravel endpoints with
// the SAME wire shapes. Extracting avoids drift between the two paths.
//
// Every identity field comes strictly from `ctx` (never process.env / globals):
//   workflowUUID = ctx.run.runUuid, executorId = ctx.run.triggerId,
//   applicationID = ctx.app.appId, applicationVersion = ctx.app.appVersion.
import { randomUUID } from 'crypto';
import { serializeError } from 'serialize-error';
import { StatusString } from '../workflow';
import { GlobalLogger } from '../telemetry/logs';
import { SolidActionsJSON } from '../serialization';
import { collectSecretStrings, scrubSecretsFromString } from './secret-redaction';
import type { InvokeCtx, InvokeResult } from './types';

const logger = new GlobalLogger();

/**
 * Step 0 — the run-row CREATE (HttpSystemDatabase.initWorkflowStatus shape).
 * Awaited BEFORE invoke() so the body's step()/sleep/recv schedule POSTs hit an
 * existing row instead of 404ing. Best-effort swallow (the reaper reconciles).
 *
 * Every identity field comes strictly from `ctx` (the ALS/ctx scope) — never
 * bootParams: workflowUUID = ctx.run.runUuid, executorId = ctx.run.triggerId,
 * applicationID = ctx.app.appId, applicationVersion = ctx.app.appVersion,
 * createdAt = now. `workflowName` is derived by the caller (legacy
 * getRegisteredFunctionFullName) and threaded in.
 *
 * NOTE the non-transient hazard: an empty applicationID → real
 * RunStatusController::store() 422s → the output/error PUT then 404s and is
 * swallowed → silent persistence loss. appId MUST come from the runner, never
 * be faked. The e2e parity gate must assert the row-create returns 2xx.
 */
export async function initRunStatusRow(ctx: InvokeCtx, workflowName: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy require to break the module-load cycle (see invoke.ts import-block comment)
  const { HttpClient } = require('../http_client') as typeof import('../http_client');
  const client = new HttpClient({ baseUrl: ctx.api.url, apiKey: ctx.api.key }, logger);
  const workflowID = ctx.run.runUuid;
  try {
    await client.post('/runs/status', {
      workflowUUID: workflowID,
      status: StatusString.PENDING,
      workflowName,
      workflowClassName: '',
      workflowConfigName: '',
      output: null,
      error: null,
      authenticatedUser: '',
      assumedRole: '',
      authenticatedRoles: [],
      request: {},
      executorId: String(ctx.run.triggerId),
      applicationVersion: ctx.app.appVersion,
      applicationID: ctx.app.appId,
      createdAt: Date.now(),
      priority: 0,
      ownerXid: randomUUID(),
      options: {},
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to create run status row for ${workflowID}: ${errMsg}`);
  }
}

/**
 * Steps 1+2 — the terminal-state writes from the InvokeResult AFTER invoke().
 *
 *  - completed → PUT /runs/status/<id>/output  { output, status: SUCCESS } then workflow-complete POST
 *  - failed    → PUT /runs/status/<id>/error   { error,  status: ERROR }   then workflow-complete POST
 *  - cancelled → PUT /runs/status/<id>/output  { output: null, status: CANCELLED }, NO workflow-complete POST
 *  - suspended → no-op (the durable sleep/recv schedule was already POSTed; row already created)
 *
 * Identity is strictly from `ctx.run.runUuid`. Errors are swallowed best-effort
 * (the infra webhook/reaper is the fallback). The row CREATE (initRunStatusRow)
 * was already awaited BEFORE invoke() so these PUTs 200.
 *
 * Task 3.3 §9.10: scrub plaintext secrets (ConnectionVar.key + proxyToken of
 * every ctx.vars entry) BEFORE the PUT crosses the persistence boundary,
 * mirroring the per-step scrubbing the invoke.ts step primitive already does.
 */
export async function reportTerminalState(ctx: InvokeCtx, result: InvokeResult): Promise<void> {
  if (result.status === 'suspended') {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy require (see above)
  const { HttpClient } = require('../http_client') as typeof import('../http_client');
  const client = new HttpClient({ baseUrl: ctx.api.url, apiKey: ctx.api.key }, logger);
  const workflowID = ctx.run.runUuid;
  const encodedID = encodeURIComponent(workflowID);

  // Task 2.8 — cancelled: a single durable status-row write carrying CANCELLED
  // status and NO output/error payload, then NO workflow-complete POST.
  // Mirrors the legacy executor's cancelled-self branch (solidactions-executor.ts:606-611)
  // which set CANCELLED and re-threw WITHOUT calling recordWorkflowError or
  // reportWorkflowComplete.
  if (result.status === 'cancelled') {
    try {
      await client.put(`/runs/status/${encodedID}/output`, { output: null, status: StatusString.CANCELLED });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to persist run status CANCELLED for ${workflowID}: ${errMsg}`);
    }
    return;
  }

  const secretStrings = collectSecretStrings(ctx.vars);
  try {
    if (result.status === 'completed') {
      const outputSerialized = SolidActionsJSON.stringify(result.output) ?? 'null';
      await client.put(`/runs/status/${encodedID}/output`, {
        output: scrubSecretsFromString(outputSerialized, secretStrings),
        status: StatusString.SUCCESS,
      });
    } else {
      const errorSerialized = SolidActionsJSON.stringify(serializeError(result.error)) ?? 'null';
      await client.put(`/runs/status/${encodedID}/error`, {
        error: scrubSecretsFromString(errorSerialized, secretStrings),
        status: StatusString.ERROR,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to persist run status ${result.status === 'completed' ? 'output' : 'error'} for ${workflowID}: ${errMsg}`);
  }

  try {
    if (result.status === 'completed') {
      await client.post(`/runs/status/${encodedID}/workflow-complete`, { status: 'completed', output: result.output });
    } else {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      await client.post(`/runs/status/${encodedID}/workflow-complete`, { status: 'failed', error: message });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to report workflow completion for ${workflowID} (${result.status}): ${errMsg}`);
  }
}
