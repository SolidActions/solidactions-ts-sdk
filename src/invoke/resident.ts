/**
 * runResident — the resident-mode lifecycle entrypoint (Blaxel Phase-1 MVP).
 *
 * Mirrors SolidActions.run() (solidactions.ts:810-922):
 *   1. build ctx from the dispatched /run BODY via residentContextAdapter (async);
 *   2. create the durable run-status row BEFORE invoke() (initRunStatusRow) — so
 *      the body's first step()/sleep/recv POST to /runs/status/<id>/... hits an
 *      existing row instead of 404ing;
 *   3. invoke(workflow, ctx);
 *   4. report the terminal/suspend state (reportTerminalState) — a no-op on
 *      suspend (the sleep/recv/child schedule was already POSTed inside invoke()),
 *      and a CANCELLED row write (no workflow-complete) on cancelled.
 *
 * CRUCIAL DIFFERENCE vs. run(): it RETURNS the InvokeResult and NEVER calls
 * process.exit, so the warm resident process can re-invoke on the next dispatch.
 * The resident server (Unit B) maps the returned result to the trigger
 * complete/fail callbacks — including the suspend → infra-completion (exit 0)
 * callback so the WorkerSession doesn't stay open while Laravel marks the trigger
 * sleeping. The SDK here owns ONLY the durable /runs/status/... writes.
 */
import { getFunctionRegistration } from '../decorators';
import { residentContextAdapter } from './context-adapter';
import type { ResidentRunBody } from './context-adapter';
import { initRunStatusRow, reportTerminalState } from './run-status-lifecycle';
import type { InvokeCtx, InvokeResult, WorkflowDescriptor } from './types';

export async function runResident<I, O>(
  workflow: WorkflowDescriptor<I, O>,
  body: ResidentRunBody,
): Promise<InvokeResult<O>> {
  // Lazy require(): a STATIC import of invoke() creates the same module-load
  // cycle through http_system_database that SolidActions.run() guards against
  // (solidactions.ts:836-844: "Class extends value undefined"). Deferring to
  // call-time breaks the cycle; require() matches the codebase's lazy-load idiom
  // and resolves under ts-jest's extensionless resolution.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy require to break the module-load cycle (see SolidActions.run import-block comment)
  const { invoke } = require('./invoke') as typeof import('./invoke');

  const ctx = await residentContextAdapter(body);

  // Derive workflowName identically to SolidActions.run() (solidactions.ts:862-863).
  // defineWorkflow annotates the descriptor's `.name`, so it is the primary
  // source; the legacy registration name and the literal 'workflow' are the
  // fallbacks. A non-empty value is required: RunStatusController::store()
  // validates `workflowName => required|string`.
  const workflowReg = getFunctionRegistration(workflow as object);
  const workflowName = workflow.name || workflowReg?.name || 'workflow';

  await initRunStatusRow(ctx, workflowName);
  const result = await invoke<I, O>(workflow, ctx as unknown as InvokeCtx<I>);
  await reportTerminalState(ctx, result);
  return result;
}
