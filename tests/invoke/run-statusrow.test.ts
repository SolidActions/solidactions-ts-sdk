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
 * The real backend's recordOutput/recordError 404 (no upsert) when the
 * RunStatus row is absent, and DispatchTriggerToDaytona never creates it — so
 * the legacy executor's initWorkflowStatus (`POST /runs/status`) row-CREATE is
 * a load-bearing precondition. The one-shot run() path must reproduce it too.
 *
 * This suite proves the rewritten one-shot run() reproduces the FULL durable
 * status-row lifecycle from the InvokeResult, in order:
 *  - completed  → `POST /runs/status` (row create) THEN
 *                 `PUT .../output {output,status:SUCCESS}` (output = the
 *                 SolidActionsJSON.stringify'd value, a string) THEN
 *                 the workflow-complete POST; the PUT path's run id is the
 *                 ctx run uuid (identity from ctx, not a global/bootParams).
 *  - failed     → row create THEN `PUT .../error {error,status:ERROR}` (error =
 *                 the serialize-error + SolidActionsJSON.stringify'd value)
 *                 THEN the POST.
 *  - no-seed    → with NO pre-seeded row, the one-shot path itself issues the
 *                 `POST /runs/status` create BEFORE the output PUT, proving the
 *                 create path works without external seeding.
 *  - no-seed +  → with NO pre-seeded row AND a STEP-ful body, the row create
 *    stepful      precedes the FIRST step-record POST
 *                 (`POST /runs/status/<id>/operations`) — proving the row
 *                 exists BEFORE invoke() runs the body (Task 2.4b ordering
 *                 fix; the real-Daytona parity break this suite missed because
 *                 the stepless no-seed case never POSTed a step pre-create).
 *  - suspended  → row create still happens (BEFORE invoke, so the step +
 *                 durable sleep schedule 200), but NEITHER output/error PUT
 *                 nor workflow-complete POST (run not terminal; exit 0).
 *
 * Mock wiring mirrors run-compat.test.ts: the one-shot ContextAdapter maps
 * SOLIDACTIONS_API_URL/KEY/RUN_ID → ctx.api.url/key + ctx.run.runUuid.
 */
/* eslint-disable @typescript-eslint/require-await --
 * The workflow fixtures are intentionally `async` (matching the one-shot run()
 * contract) even when their bodies have no await — that is the shape under
 * test, not a mistake. */
import { serializeError } from 'serialize-error';
import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import { MockHttpServer } from '../../src/testing/mock_server';
import { SolidActionsJSON } from '../../src/serialization';

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
  // row BEFORE the one-shot process starts; this seeding keeps the
  // completed/failed cases focused on the PUT shape. The dedicated no-seed
  // case below removes this seeding to prove run() itself creates the row.
  // Test setup only — does NOT alter run(), invoke()/engine, or mock behavior.
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

it('completed → row create THEN PUT .../output {output,status:SUCCESS} THEN workflow-complete POST; output is the SolidActionsJSON-stringified value; run id from ctx', async () => {
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
  expect(outputPut!.body.status).toBe('SUCCESS');
  // Legacy serialized shape: recordWorkflowOutput PUTs `internalStatus.output`,
  // which the legacy executor set to `funcResult.stringified`
  // (src/solidactions-executor.ts:592) — the SolidActionsJSON.stringify'd value
  // (a STRING; the real backend validates `output => nullable|string`).
  expect(typeof outputPut!.body.output).toBe('string');
  expect(outputPut!.body.output).toBe(SolidActionsJSON.stringify(42));
  // It round-trips through the legacy serializer to the expected value.
  expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(42);

  // The row-create POST must precede the output PUT, which must precede the
  // workflow-complete POST (legacy: initWorkflowStatus → recordWorkflowOutput
  // → reportWorkflowComplete).
  const rowCreate = srv.lastRunStatusCreate();
  expect(rowCreate).toBeTruthy();
  const completeIdx = srv.lastWorkflowCompleteIndex();
  expect(completeIdx).toBeTruthy();
  expect(rowCreate!.index).toBeLessThan(outputPut!.index);
  expect(outputPut!.index).toBeLessThan(completeIdx!);

  // No error PUT on the success path.
  expect(srv.lastErrorPut()).toBeUndefined();
  // The completion POST is still emitted (Task 2.3 contract unchanged): the
  // workflow-complete POST keeps the RAW output (legacy reportWorkflowComplete
  // received `result` raw, not the stringified form).
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
  expect(srv.lastWorkflowComplete()!.output).toEqual(42);
});

it('failed → row create THEN PUT .../error {error,status:ERROR} THEN workflow-complete POST; error is the serialize-error + SolidActionsJSON-stringified value; run id from ctx', async () => {
  const wf = SolidActions.registerWorkflow(async () => {
    throw new Error('boom');
  });
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code).toBe(1);

  const errorPut = srv.lastErrorPut();
  expect(errorPut).toBeTruthy();
  expect(errorPut!.workflowID).toBe(RUN_ID);
  expect(errorPut!.body.status).toBe('ERROR');
  // Legacy serialized shape: recordWorkflowError PUTs `internalStatus.error`,
  // which the legacy executor set to `serializer.stringify(serializeError(e))`
  // (src/solidactions-executor.ts:531) — a serialize-error + SolidActionsJSON
  // STRING, NOT a bare message. It must contain the Error name AND message.
  expect(typeof errorPut!.body.error).toBe('string');
  // The value is the legacy serialized form: it round-trips through the legacy
  // serializer (SolidActionsJSON) back to a serialize-error object with the
  // Error name + message + stack — exactly the shape
  // `SolidActionsJSON.stringify(serializeError(err))` produces (byte-identical
  // mirror of src/invoke/invoke.ts:108). Compared structurally (the `stack`
  // string is call-site-dependent and intentionally not pinned).
  const decodedErr = SolidActionsJSON.parse(errorPut!.body.error as string) as {
    name?: string;
    message?: string;
    stack?: string;
  };
  const referenceShape = SolidActionsJSON.parse(
    SolidActionsJSON.stringify(serializeError(new Error('boom'))),
  ) as { name?: string; message?: string; stack?: string };
  expect(decodedErr.name).toBe('Error');
  expect(decodedErr.name).toBe(referenceShape.name);
  expect(decodedErr.message).toBe('boom');
  expect(decodedErr.message).toBe(referenceShape.message);
  // serialize-error attaches a stack (proves it is serializeError'd, not a raw
  // {message} or bare string).
  expect(typeof decodedErr.stack).toBe('string');
  expect(decodedErr.stack).toContain('Error: boom');
  // Not a bare message string.
  expect(errorPut!.body.error).not.toBe('boom');

  const rowCreate = srv.lastRunStatusCreate();
  expect(rowCreate).toBeTruthy();
  const completeIdx = srv.lastWorkflowCompleteIndex();
  expect(completeIdx).toBeTruthy();
  expect(rowCreate!.index).toBeLessThan(errorPut!.index);
  expect(errorPut!.index).toBeLessThan(completeIdx!);

  expect(srv.lastOutputPut()).toBeUndefined();
  expect(srv.lastWorkflowComplete()!.status).toBe('failed');
  // The workflow-complete POST keeps the BARE message (legacy
  // reportWorkflowComplete(workflowID, 'failed', undefined, e.message)).
  expect(srv.lastWorkflowComplete()!.error).toBe('boom');
});

it('NO pre-seeded row → run() itself POSTs /runs/status (row create) BEFORE the output PUT; the PUT then succeeds', async () => {
  // Remove the beforeEach seeding for THIS run id: prove the one-shot path
  // creates the row itself (without external seeding), exactly like a real
  // trigger run where DispatchTriggerToDaytona does NOT create the row.
  const FRESH_RUN_ID = '00000000-0000-4000-8000-00000000024c';
  srv.store.workflows.delete(FRESH_RUN_ID); // belt-and-suspenders: never seeded
  expect(srv.store.workflows.has(FRESH_RUN_ID)).toBe(false);

  const wf = SolidActions.registerWorkflow(async (input: { n: number }) => input.n + 1);
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    {
      SOLIDACTIONS_API_URL: srv.baseUrl,
      SOLIDACTIONS_API_KEY: 'test-api-key',
      SOLIDACTIONS_RUN_ID: FRESH_RUN_ID,
      WORKFLOW_INPUT: JSON.stringify({ n: 41 }),
    },
  );
  expect(code).toBe(0);

  // The row-create POST happened (the create path works without external
  // seeding) and the row now exists in the store.
  const rowCreate = srv.lastRunStatusCreate();
  expect(rowCreate).toBeTruthy();
  expect(rowCreate!.body.workflowUUID).toBe(FRESH_RUN_ID);
  expect(srv.store.workflows.has(FRESH_RUN_ID)).toBe(true);

  // The output PUT succeeded because the row existed (without the create it
  // would 404 on the real backend; the mock 404s on an absent row too).
  const outputPut = srv.lastOutputPut();
  expect(outputPut).toBeTruthy();
  expect(outputPut!.workflowID).toBe(FRESH_RUN_ID);
  expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(42);
  // Persisted into the store row (proves the PUT 200'd, not 404'd).
  expect(SolidActionsJSON.parse(srv.store.workflows.get(FRESH_RUN_ID)!.output as string)).toEqual(42);

  // Order: rowCreate POST index < outputPut index < workflow-complete POST index.
  const completeIdx = srv.lastWorkflowCompleteIndex();
  expect(completeIdx).toBeTruthy();
  expect(rowCreate!.index).toBeLessThan(outputPut!.index);
  expect(outputPut!.index).toBeLessThan(completeIdx!);
});

it('NO pre-seeded row + STEP-ful body → run() POSTs /runs/status (row create) BEFORE the workflow body records ANY step; the step record then 200s and the run completes', async () => {
  // REGRESSION (real-Daytona Task 2.4b ordering break): the existing no-seed
  // case above used a STEPLESS workflow, so the workflow body never POSTed a
  // step BEFORE the row-create — it could not catch the create-vs-run
  // inversion. Here the body calls SolidActions.runStep() AT LEAST ONCE (mirror
  // run-compat.test.ts's sleep/step legacy-workflow registration). On a real
  // trigger run DispatchTriggerToDaytona does NOT create the row, so the
  // step's recordOperationResult `POST /runs/status/<id>/operations` runs
  // against an absent row. If the row-create POST happens AFTER invoke()
  // (the pre-fix #reportOneShotCompletion Step 0), that operations POST 404s
  // ("Workflow not found" — the mock mirrors the real backend's "Run not
  // found"), invoke()'s body try/catch records the run FAILED, and exit is 1.
  // The fix moves the row-create BEFORE invoke().
  const STEP_RUN_ID = '00000000-0000-4000-8000-00000000024d';
  srv.store.workflows.delete(STEP_RUN_ID); // belt-and-suspenders: never seeded
  srv.store.operations.delete(STEP_RUN_ID);
  expect(srv.store.workflows.has(STEP_RUN_ID)).toBe(false);

  const wf = SolidActions.registerWorkflow(async (input: { n: number }) => {
    const doubled = await SolidActions.runStep(() => input.n * 2);
    return doubled + 1;
  });
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    {
      SOLIDACTIONS_API_URL: srv.baseUrl,
      SOLIDACTIONS_API_KEY: 'test-api-key',
      SOLIDACTIONS_RUN_ID: STEP_RUN_ID,
      WORKFLOW_INPUT: JSON.stringify({ n: 20 }),
    },
  );
  // The run completes (exit 0) — proving the step's recordOperationResult got
  // 200, not 404. Pre-fix this is 1 (run recorded FAILED, phase 'run').
  expect(code).toBe(0);

  // The row-create POST must precede the FIRST step-record POST
  // (`POST /runs/status/<id>/operations`) — i.e. the row exists before the
  // workflow body records any step. Raw on-the-wire path match, mirroring the
  // established read-only requestLog accessors (lastRunStatusCreate etc.).
  const rowCreate = srv.lastRunStatusCreate();
  expect(rowCreate).toBeTruthy();
  expect(rowCreate!.body.workflowUUID).toBe(STEP_RUN_ID);

  const opsPostRe = /^\/(?:runs\/status|workflows)\/[^/]+\/operations$/;
  const firstOpsPostIndex = srv.requestLog.findIndex(
    (e) => e.method === 'POST' && opsPostRe.test(e.path),
  );
  expect(firstOpsPostIndex).toBeGreaterThanOrEqual(0); // a step WAS recorded
  expect(rowCreate!.index).toBeLessThan(firstOpsPostIndex);

  // The output PUT 200'd (row existed) and the result is persisted: (20*2)+1.
  const outputPut = srv.lastOutputPut();
  expect(outputPut).toBeTruthy();
  expect(outputPut!.workflowID).toBe(STEP_RUN_ID);
  expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(41);
  expect(SolidActionsJSON.parse(srv.store.workflows.get(STEP_RUN_ID)!.output as string)).toEqual(41);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
});

it('suspended (sleep, no pre-seed) → row create BEFORE invoke (step record + sleep schedule 200) but NEITHER output nor error PUT, exit 0', async () => {
  // Task 2.4b ORDERING FIX: the row CREATE now happens BEFORE invoke()
  // REGARDLESS of outcome — suspended runs need the row too: their step
  // recordOperationResult AND durable sleep/recv schedule POST
  // `/runs/status/<id>/...` sub-routes that 404 on an absent row (same real
  // "Run not found" failure mode). Use a FRESH, NON-pre-seeded run id so this
  // proves the create runs ahead of the body's step + sleep without external
  // seeding (the seeded RUN_ID would mask it). What stays terminal-NEUTRAL on
  // suspension is the OUTPUT/ERROR PUT and the workflow-complete POST — never
  // the row create.
  const SUSP_RUN_ID = '00000000-0000-4000-8000-00000000024e';
  srv.store.workflows.delete(SUSP_RUN_ID); // belt-and-suspenders: never seeded
  srv.store.operations.delete(SUSP_RUN_ID);
  expect(srv.store.workflows.has(SUSP_RUN_ID)).toBe(false);

  const wf = SolidActions.registerWorkflow(async () => {
    await SolidActions.runStep(() => 'step-A');
    await SolidActions.sleepms(60_000);
    return 'after-sleep';
  });
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    {
      SOLIDACTIONS_API_URL: srv.baseUrl,
      SOLIDACTIONS_API_KEY: 'test-api-key',
      SOLIDACTIONS_RUN_ID: SUSP_RUN_ID,
      WORKFLOW_INPUT: '{}',
    },
  );
  expect(code).toBe(0);

  // The row WAS created (before invoke), so the step record + sleep schedule
  // both 200'd against an existing row instead of 404ing.
  const rowCreate = srv.lastRunStatusCreate();
  expect(rowCreate).toBeTruthy();
  expect(rowCreate!.body.workflowUUID).toBe(SUSP_RUN_ID);
  expect(srv.store.workflows.has(SUSP_RUN_ID)).toBe(true);

  // Row-create precedes the FIRST step-record POST (proving create-before-run).
  const opsPostRe = /^\/(?:runs\/status|workflows)\/[^/]+\/operations$/;
  const firstOpsPostIndex = srv.requestLog.findIndex(
    (e) => e.method === 'POST' && opsPostRe.test(e.path),
  );
  expect(firstOpsPostIndex).toBeGreaterThanOrEqual(0); // step-A WAS recorded
  expect(rowCreate!.index).toBeLessThan(firstOpsPostIndex);

  // Terminal-neutral on suspension: NO durable output/error PUT and NO
  // workflow-complete POST (the run is not terminal yet).
  expect(srv.lastOutputPut()).toBeUndefined();
  expect(srv.lastErrorPut()).toBeUndefined();
  expect(srv.lastWorkflowCompleteIndex()).toBeUndefined();
  // The sleep schedule was still posted (Task 2.3 contract unchanged).
  expect(srv.lastSleepSchedule()).toBeTruthy();
});
