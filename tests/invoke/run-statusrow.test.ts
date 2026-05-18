/**
 * Task 2.4b — status-row lifecycle reconstruction on the one-shot run() path.
 *
 * Task 2.3 reproduced ONLY the fire-and-forget completion POST
 * (`POST /runs/status/<id>/workflow-complete`). In the real Laravel backend
 * that POST DISCARDS its `output`/`error` body — `RunStatus.output|error` are
 * persisted ONLY by the durable status-row PUTs:
 *   - completed → `PUT /runs/status/<id>/output  { output, status: SUCCESS }`
 *     (HttpSystemDatabase.recordWorkflowOutput)
 *   - failed    → `PUT /runs/status/<id>/error   { error,  status: ERROR }`
 *     (HttpSystemDatabase.recordWorkflowError)
 * issued by the legacy executor BEFORE reportWorkflowComplete (see
 * src/solidactions-executor.ts runWorkflow / handleWorkflowError).
 *
 * This suite proves the rewritten one-shot run() reproduces that durable
 * status-row write sequence from the InvokeResult:
 *  - completed  → a `PUT .../output {output, status:SUCCESS}` reaches the mock
 *                 BEFORE the workflow-complete POST; the PUT path's run id is
 *                 the ctx run uuid (identity from ctx, not a global/bootParams).
 *  - failed     → a `PUT .../error {error, status:ERROR}` BEFORE the POST.
 *  - suspended  → NEITHER PUT (and exit 0).
 *
 * Mock wiring mirrors run-compat.test.ts: the one-shot ContextAdapter maps
 * SOLIDACTIONS_API_URL/KEY/RUN_ID → ctx.api.url/key + ctx.run.runUuid.
 */
/* eslint-disable @typescript-eslint/require-await --
 * The workflow fixtures are intentionally `async` (matching the one-shot run()
 * contract) even when their bodies have no await — that is the shape under
 * test, not a mistake. */
import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import { MockHttpServer } from '../../src/testing/mock_server';

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

/** The run id the one-shot ContextAdapter maps to ctx.run.runUuid. */
const RUN_ID = '00000000-0000-4000-8000-00000000024b';

beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;

  // Pre-seed the run row, exactly as run-compat.test.ts / concurrency.test.ts
  // do. In a real deployment the Laravel trigger-dispatch path creates the run
  // row BEFORE the one-shot process starts; the invoke() engine deliberately
  // never calls initWorkflowStatus (see src/invoke/invoke.ts header), and the
  // mock's recordOutput/recordError 404 for an unknown workflow. Test setup
  // only — does NOT alter run(), invoke()/engine, or mock behavior.
  srv.store.workflows.set(RUN_ID, {
    workflowUUID: RUN_ID,
    status: 'PENDING',
    workflowName: '',
    workflowClassName: '',
    workflowConfigName: '',
    authenticatedUser: '',
    assumedRole: '',
    authenticatedRoles: [],
    request: {},
    executorId: 'test-trigger',
    applicationVersion: '',
    applicationID: '',
    input: null,
    output: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    recoveryAttempts: 0,
    priority: 0,
  });
  srv.store.operations.set(RUN_ID, []);
});

/** Env that points the one-shot ContextAdapter at the running mock. */
function mockEnv(extra: Record<string, string>): Record<string, string> {
  return {
    SOLIDACTIONS_API_URL: srv.baseUrl,
    SOLIDACTIONS_API_KEY: 'test-api-key',
    SOLIDACTIONS_RUN_ID: RUN_ID,
    ...extra,
  };
}

it('completed → PUT .../output {output,status:SUCCESS} BEFORE workflow-complete POST, run id from ctx', async () => {
  const wf = SolidActions.registerWorkflow(async (input: { n: number }) => input.n * 2);
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    mockEnv({ WORKFLOW_INPUT: JSON.stringify({ n: 21 }) }),
  );
  expect(code).toBe(0);

  // The durable output PUT must have happened (Task 2.3 only did the POST).
  const outputPut = srv.lastOutputPut();
  expect(outputPut).toBeTruthy();
  // Identity-from-ctx: the PUT path's run id is the ctx run uuid (RUN_ID via
  // SOLIDACTIONS_RUN_ID), proving it is NOT sourced from a global / bootParams.
  expect(outputPut!.workflowID).toBe(RUN_ID);
  // Faithful legacy shape: recordWorkflowOutput body {output, status:SUCCESS}.
  expect(outputPut!.body.output).toEqual(42);
  expect(outputPut!.body.status).toBe('SUCCESS');

  // Order-sensitive: the PUT must precede the workflow-complete POST (legacy
  // executor: recordWorkflowOutput THEN reportWorkflowComplete).
  const completeIdx = srv.lastWorkflowCompleteIndex();
  expect(completeIdx).toBeTruthy();
  expect(outputPut!.index).toBeLessThan(completeIdx!);

  // No error PUT on the success path.
  expect(srv.lastErrorPut()).toBeUndefined();
  // The completion POST is still emitted (Task 2.3 contract unchanged).
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
});

it('failed → PUT .../error {error,status:ERROR} BEFORE workflow-complete POST, run id from ctx', async () => {
  const wf = SolidActions.registerWorkflow(async () => {
    throw new Error('boom');
  });
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code).toBe(1);

  const errorPut = srv.lastErrorPut();
  expect(errorPut).toBeTruthy();
  expect(errorPut!.workflowID).toBe(RUN_ID);
  // Faithful legacy shape: recordWorkflowError body {error, status:ERROR}.
  expect(errorPut!.body.status).toBe('ERROR');
  expect(typeof errorPut!.body.error).toBe('string');
  expect(String(errorPut!.body.error)).toContain('boom');

  const completeIdx = srv.lastWorkflowCompleteIndex();
  expect(completeIdx).toBeTruthy();
  expect(errorPut!.index).toBeLessThan(completeIdx!);

  expect(srv.lastOutputPut()).toBeUndefined();
  expect(srv.lastWorkflowComplete()!.status).toBe('failed');
});

it('suspended (sleep) → NEITHER output nor error PUT, exit 0', async () => {
  const wf = SolidActions.registerWorkflow(async () => {
    await SolidActions.runStep(() => 'step-A');
    await SolidActions.sleepms(60_000);
    return 'after-sleep';
  });
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code).toBe(0);

  // Suspension is terminal-neutral: no status-row output/error write.
  expect(srv.lastOutputPut()).toBeUndefined();
  expect(srv.lastErrorPut()).toBeUndefined();
  // The sleep schedule was still posted (Task 2.3 contract unchanged).
  expect(srv.lastSleepSchedule()).toBeTruthy();
});
