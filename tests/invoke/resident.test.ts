/**
 * Branch coverage for runResident() — the resident-mode lifecycle entrypoint
 * (Blaxel Phase-1 MVP, Task A.3).
 *
 * Uses the real mock server harness — NO mocks/spies/stubs/fakes.
 *
 * The load-bearing invariant asserted here: runResident RETURNS the InvokeResult
 * and NEVER calls process.exit, so a warm resident process can re-invoke on the
 * next dispatch. The jest.setup process.exit interceptor is left UNARMED so a
 * stray process.exit would actually kill the worker (failing the run) — and the
 * "warm re-invoke" test proves a second call on the same module succeeds.
 *
 * NOTE on fixtures: defineWorkflow requires a `{ run }` DESCRIPTOR (not a bare
 * function — see src/invoke/define-workflow.ts), and the run() body receives
 * `InvokeCtx<I> & DurablePrimitives`, so `ctx.input` / `ctx.sleep` are present.
 * The plan's shorthand `defineWorkflow(async (ctx) => ...)` is adapted to the
 * real `{ name, run }` form.
 */

/* eslint-disable @typescript-eslint/require-await --
 * The workflow fixtures are intentionally `async` (WorkflowDescriptor.run returns
 * Promise<O>) even when their bodies have no await — that is the shape under
 * test, not a mistake. */

// jest globals — describe/it/expect are ambient; do NOT import from 'vitest'
import { runResident } from '../../src/invoke/resident';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { __clearRegistry } from '../../src/invoke/registry';
import { setUpSolidActionsTestServer, tearDownSolidActionsTestServer } from '../helpers';
import { MockHttpServer } from '../../src/testing/mock_server';
import { SolidActionsJSON } from '../../src/serialization';
import { StatusString } from '../../src/workflow';
import type { InvokeCtx, DurablePrimitives } from '../../src/invoke/types';

let srv: MockHttpServer;
beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});
afterAll(async () => {
  await tearDownSolidActionsTestServer();
});
beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;
  __clearRegistry();
});

const RUN_ID = '00000000-0000-4000-8000-0000000000a1';

/** Build the dispatched /run body pointed at the mock server. */
function body(extraEnv: Record<string, string> = {}) {
  return {
    triggerId: '7',
    runSecret: 'secret',
    workerSessionId: 'ws-1',
    envVars: {
      SOLIDACTIONS_API_URL: srv.baseUrl,
      SOLIDACTIONS_API_KEY: '7:secret',
      SOLIDACTIONS_RUN_ID: RUN_ID,
      SOLIDACTIONS__APPID: 'app',
      SOLIDACTIONS__APPVERSION: 'v1',
      TENANT_ID: 't',
      WORKFLOW_INPUT: JSON.stringify({ n: 21 }),
      ...extraEnv,
    },
  };
}

it('completed → returns {status:"completed"}, creates row BEFORE the output PUT, writes output, NEVER exits', async () => {
  const wf = defineWorkflow<{ n: number }, number>({
    name: 'residentCompletes',
    run: async (ctx) => ctx.input.n * 2,
  });
  const result = await runResident(wf, body());
  expect(result).toEqual({ status: 'completed', output: 42 });

  const rowCreate = srv.lastRunStatusCreate();
  const outputPut = srv.lastOutputPut();
  expect(rowCreate).toBeTruthy();
  expect(outputPut).toBeTruthy();
  expect(outputPut!.workflowID).toBe(RUN_ID);
  expect(rowCreate!.index).toBeLessThan(outputPut!.index);
  expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(42);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
});

it('failed → returns {status:"failed"} and writes the error PUT (no output PUT)', async () => {
  const wf = defineWorkflow<unknown, never>({
    name: 'residentFails',
    run: async () => {
      throw new Error('boom');
    },
  });
  const result = await runResident(wf, body());
  expect(result.status).toBe('failed');
  expect(srv.lastErrorPut()).toBeTruthy();
  expect(srv.lastOutputPut()).toBeUndefined();
  expect(srv.lastWorkflowComplete()!.status).toBe('failed');
});

it('suspended (sleep) → returns {status:"suspended",reason:"sleep"}; row created, sleep scheduled, NO output/error PUT, NO workflow-complete POST', async () => {
  const wf = defineWorkflow<unknown, string>({
    name: 'residentSleeps',
    run: async (ctx) => {
      await ctx.sleep(60_000);
      return 'after-sleep';
    },
  });
  const result = await runResident(wf, body());
  expect(result).toEqual({ status: 'suspended', reason: 'sleep' });
  expect(srv.lastRunStatusCreate()).toBeTruthy();
  expect(srv.lastSleepSchedule()).toBeTruthy();
  expect(srv.lastOutputPut()).toBeUndefined();
  expect(srv.lastErrorPut()).toBeUndefined();
  expect(srv.lastWorkflowCompleteIndex()).toBeUndefined();
});

it('cancelled → returns {status:"cancelled"} and writes a single CANCELLED output PUT, no workflow-complete POST', async () => {
  // Task A.4 — explicit cancelled-branch coverage for runResident.
  //
  // Mirrors the cancellation.test.ts cancel mechanism: seed the run row as
  // CANCELLED so the engine's getOperationResultAndThrowIfCancelled (reached on
  // the first step() call) sees the CANCELLED row and throws
  // SolidActionsWorkflowCancelledError. invoke() maps that to
  // { status: 'cancelled' }. reportTerminalState writes the CANCELLED output PUT
  // and returns without POSTing /workflow-complete.
  const CANCEL_RUN_ID = '00000000-0000-4000-8000-0000000000a9';

  // Seed the run row as CANCELLED (the cancel landed before this dispatch).
  // Field names match MockStore's workflow record shape (see cancellation.test.ts:88-108).
  srv.store.workflows.set(CANCEL_RUN_ID, {
    workflowUUID: CANCEL_RUN_ID,
    status: StatusString.CANCELLED,
    workflowName: '',
    workflowClassName: '',
    workflowConfigName: '',
    authenticatedUser: '',
    assumedRole: '',
    authenticatedRoles: [],
    request: {},
    executorId: '7',
    applicationVersion: 'v1',
    applicationID: 'app',
    input: null,
    output: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    recoveryAttempts: 0,
    priority: 0,
  });
  // Pre-record a sleep op (functionID 0) so the engine hits an existing op and
  // calls getOperationResultAndThrowIfCancelled, which detects the CANCELLED row
  // and throws. Without a recorded op, step() would POST a new op before
  // checking cancellation — this pre-seed forces the cancel-check path.
  srv.store.operations.set(CANCEL_RUN_ID, [
    {
      workflowUUID: CANCEL_RUN_ID,
      functionId: 0,
      functionName: 'SolidActions.sleep',
      output: JSON.stringify({ wakeupTime: Date.now() + 60_000 }),
      error: null,
    },
  ]);

  const wf = defineWorkflow<unknown, string>({
    name: 'residentCancelled',
    run: async (ctx) => {
      await ctx.sleep(60_000);
      return 'unreachable';
    },
  });

  const result = await runResident(wf, body({ SOLIDACTIONS_RUN_ID: CANCEL_RUN_ID }));

  // runResident must RETURN (not throw, not process.exit) with { status: 'cancelled' }.
  expect(result.status).toBe('cancelled');

  // reportTerminalState must write the CANCELLED output PUT (status: CANCELLED,
  // no output payload).
  const outputPut = srv.lastOutputPut();
  expect(outputPut).toBeTruthy();
  expect(outputPut!.workflowID).toBe(CANCEL_RUN_ID);
  expect(outputPut!.body.status).toBe(StatusString.CANCELLED);

  // Must NOT POST /workflow-complete (legacy: reportWorkflowComplete was never
  // reached on the cancelled-self path).
  expect(srv.lastWorkflowCompleteIndex()).toBeUndefined();
});

it('returns and does not call process.exit (a second call on the same module is possible — warm re-invoke)', async () => {
  const wf = defineWorkflow<{ n: number }, number>({
    name: 'residentWarmReinvoke',
    run: async (ctx) => ctx.input.n + 1,
  });
  const a = await runResident(
    wf,
    body({ WORKFLOW_INPUT: JSON.stringify({ n: 1 }), SOLIDACTIONS_RUN_ID: '00000000-0000-4000-8000-0000000000a2' }),
  );
  const b = await runResident(
    wf,
    body({ WORKFLOW_INPUT: JSON.stringify({ n: 2 }), SOLIDACTIONS_RUN_ID: '00000000-0000-4000-8000-0000000000a3' }),
  );
  expect(a).toEqual({ status: 'completed', output: 2 });
  expect(b).toEqual({ status: 'completed', output: 3 });
});

// Reference the imported types so the unused-import lint stays quiet — these are
// the exact ctx shapes runResident threads through invoke().
const _typeWitness: (ctx: InvokeCtx & DurablePrimitives) => void = () => {};
void _typeWitness;
