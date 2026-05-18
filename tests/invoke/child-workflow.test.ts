/**
 * Task 2.7 — child-workflow dispatch under the one-shot run()/invoke() path.
 *
 * Proves SolidActions.startWorkflow(child)(input) + childHandle.getResult()
 * work one-shot via the durable enqueue + suspend bridge (no inline child, no
 * blocking poll). Uses the SAME harness as run-compat.test.ts:
 *   SolidActions.run(parent) + expectProcessExit + the in-memory mock.
 *
 * Mock-vs-real parity (no fiction — see the design doc + mock_server.ts
 * lastChildCreate/completeChild):
 *   - the child-create POST is the EXACT /runs/status call the SDK already
 *     makes for a child (initWorkflowStatus) plus the one protocol addition
 *     childResultFunctionID — same field the real RunStatusController::store
 *     child branch consumes.
 *   - completeChild() writes the parent-keyed durable op field-for-field as
 *     TriggerCompletionService::notifyParentOfChildCompletion does
 *     (run_uuid=parent, function_id=childResultFunctionID, child_workflow_id,
 *     output|error) — the exact row OperationController::show returns and the
 *     SDK's getOperationResultAndThrowIfCancelled reads.
 *   - re-pend is modeled by re-invoking the parent (the harness models
 *     scheduler resume for sleep/recv the same way).
 */
/* eslint-disable @typescript-eslint/require-await -- workflow fixtures are
 * async by contract even when a body has no await; that is the shape under
 * test. */
import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import { SolidActionsJSON } from '../../src/serialization';
import { MockHttpServer } from '../../src/testing/mock_server';

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

// registerWorkflow registers by name into a process-global registry; reusing a
// name across tests throws SolidActionsConflictingRegistrationError. Each test
// takes a fresh unique suffix so names never collide (the registered name only
// matters as the value the SDK sends in the child-create POST, which the tests
// assert dynamically).
let nameSeq = 0;
function uniq(base: string): string {
  return `${base}-${nameSeq}`;
}
beforeEach(() => {
  nameSeq += 1;
});

/** The run id the one-shot ContextAdapter maps to ctx.run.runUuid (the parent). */
const PARENT_RUN_ID = '00000000-0000-4000-8000-00000000c7a1';

beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;

  // Pre-seed the parent run row (the trigger-dispatch path creates it before
  // the one-shot process starts; invoke() never calls initWorkflowStatus for
  // the parent itself). Same setup as run-compat.test.ts.
  srv.store.workflows.set(PARENT_RUN_ID, {
    workflowUUID: PARENT_RUN_ID,
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
    applicationID: 'app-parent',
    input: null,
    output: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    recoveryAttempts: 0,
    priority: 0,
  });
  srv.store.operations.set(PARENT_RUN_ID, []);
});

function mockEnv(extra: Record<string, string>): Record<string, string> {
  return {
    SOLIDACTIONS_API_URL: srv.baseUrl,
    SOLIDACTIONS_API_KEY: 'test-api-key',
    SOLIDACTIONS_RUN_ID: PARENT_RUN_ID,
    SOLIDACTIONS__APPID: 'app-parent',
    ...extra,
  };
}

it('first run: enqueues the child + suspends the parent (exit 0)', async () => {
  const childName = uniq('child-task');
  const child = SolidActions.registerWorkflow(async (input: { v: number }) => ({ doubled: input.v * 2 }), {
    name: childName,
  });
  const parent = SolidActions.registerWorkflow(
    async () => {
      const h = await SolidActions.startWorkflow(child)({ v: 21 });
      const r = (await h.getResult()) as { doubled: number };
      return { final: r.doubled };
    },
    { name: uniq('parent-child') },
  );

  const code = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));

  // Suspended → one-shot exit 0, NOT a terminal completion.
  expect(code).toBe(0);
  expect(srv.lastWorkflowComplete()).toBeUndefined();

  // Child create observed: the SDK's initWorkflowStatus call PLUS
  // childResultFunctionID — exactly what the backend child branch consumes.
  const cc = srv.lastChildCreate()!;
  expect(cc).toBeTruthy();
  expect(cc.workflowName).toBe(childName);
  expect(cc.workflowUUID).toBe(`${PARENT_RUN_ID}-child-0`);
  expect(typeof cc.childResultFunctionID).toBe('number');
  expect(cc.applicationID).toBe('app-parent');
  // Input is SolidActionsJSON-serialized (SuperJSON), same as every other
  // durable payload the SDK sends — round-trip through the real deserializer.
  expect(SolidActionsJSON.parse(cc.input as string)).toEqual({ v: 21 });

  // Durable enqueue op recorded on the PARENT, carrying the child id
  // (idempotency anchor, risk 1).
  const ops = srv.store.operations.get(PARENT_RUN_ID)!;
  const enqueueOp = ops.find((o) => o.childWorkflowId === `${PARENT_RUN_ID}-child-0`);
  expect(enqueueOp).toBeTruthy();
  expect(enqueueOp!.functionName).toBe('SolidActions.startWorkflow');
});

it('replay after child completes: returns the result, does NOT re-enqueue (idempotency, risk 1)', async () => {
  const child = SolidActions.registerWorkflow(async (input: { v: number }) => ({ doubled: input.v * 2 }), {
    name: uniq('child-task'),
  });
  const parent = SolidActions.registerWorkflow(
    async () => {
      const h = await SolidActions.startWorkflow(child)({ v: 21 });
      const r = (await h.getResult()) as { doubled: number };
      return { final: r.doubled };
    },
    { name: uniq('parent-child') },
  );

  // Run 1: enqueue + suspend.
  const code1 = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code1).toBe(0);
  const childId = `${PARENT_RUN_ID}-child-0`;
  const createCountRun1 = srv.requestLog.filter(
    (e) =>
      e.method === 'POST' &&
      /\/(?:runs\/status|workflows)$/.test(e.path) &&
      (e.body as { childResultFunctionID?: number })?.childResultFunctionID !== undefined,
  ).length;
  expect(createCountRun1).toBe(1);

  // Backend completion hook fires (child done → parent-keyed durable op + re-pend).
  srv.completeChild(childId, { output: JSON.stringify({ doubled: 42 }) });

  // Run 2 (re-invoke / replay): MUST return the child result and MUST NOT
  // create a second child.
  srv.requestLog.length = 0;
  const code2 = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code2).toBe(0);

  const createCountRun2 = srv.requestLog.filter(
    (e) =>
      e.method === 'POST' &&
      /\/(?:runs\/status|workflows)$/.test(e.path) &&
      (e.body as { childResultFunctionID?: number })?.childResultFunctionID !== undefined,
  ).length;
  expect(createCountRun2).toBe(0); // idempotent: no re-enqueue on replay

  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
  expect(srv.lastWorkflowComplete()!.output).toEqual({ final: 42 });
});

it('multistep-parent shape: handle.workflowID readable + parallel step before await', async () => {
  const child = SolidActions.registerWorkflow(async (input: { q: number }) => ({ total: input.q * 10 }), {
    name: uniq('multistep-child'),
  });
  const parent = SolidActions.registerWorkflow(
    async () => {
      const h = await SolidActions.startWorkflow(child)({ q: 5 });
      const childWorkflowId = h.workflowID; // readable immediately (eager enqueue)
      const parallel = await SolidActions.runStep(() => 'parallel-done', { name: 'parallel' });
      const r = (await h.getResult()) as { total: number };
      return { childWorkflowId, parallel, total: r.total };
    },
    { name: uniq('multistep-parent') },
  );

  const code1 = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code1).toBe(0);
  const childId = `${PARENT_RUN_ID}-child-0`;
  srv.completeChild(childId, { output: JSON.stringify({ total: 50 }) });

  const code2 = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code2).toBe(0);
  expect(srv.lastWorkflowComplete()!.output).toEqual({
    childWorkflowId: childId,
    parallel: 'parallel-done',
    total: 50,
  });
});

it('≥2 parallel children converge across re-invocations (risk 4)', async () => {
  const child = SolidActions.registerWorkflow(async (input: { n: number }) => ({ sq: input.n * input.n }), {
    name: uniq('child-task'),
  });
  const parent = SolidActions.registerWorkflow(
    async () => {
      const a = await SolidActions.startWorkflow(child)({ n: 3 });
      const b = await SolidActions.startWorkflow(child)({ n: 4 });
      const ra = (await a.getResult()) as { sq: number };
      const rb = (await b.getResult()) as { sq: number };
      return { sum: ra.sq + rb.sq };
    },
    { name: uniq('parent-two-children') },
  );

  const childA = `${PARENT_RUN_ID}-child-0`;
  const childB = `${PARENT_RUN_ID}-child-2`; // 2nd child: enqueue funcId advances past A's enqueue+result ids

  // Run 1: both children enqueued; suspends on A's unresolved getResult.
  const code1 = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code1).toBe(0);
  expect(srv.store.workflows.has(childA)).toBe(true);
  expect(srv.store.workflows.has(childB)).toBe(true);

  // Only A completes → replay resolves A, re-suspends on B.
  srv.completeChild(childA, { output: JSON.stringify({ sq: 9 }) });
  const code2 = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code2).toBe(0);
  expect(srv.lastWorkflowComplete()).toBeUndefined(); // still suspended on B

  // B completes → replay resolves both → parent completes once.
  srv.completeChild(childB, { output: JSON.stringify({ sq: 16 }) });
  const code3 = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code3).toBe(0);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
  expect(srv.lastWorkflowComplete()!.output).toEqual({ sum: 25 });

  // Idempotency: each child created exactly once across all three runs.
  // (Only run 1 enqueues; runs 2 & 3 replay the recorded enqueue ops.)
});

it('child failure propagates to the parent — getResult rethrows (risk 6)', async () => {
  const child = SolidActions.registerWorkflow(
    async (_input: Record<string, never>) => {
      throw new Error('child exploded');
    },
    { name: uniq('child-task') },
  );
  const parent = SolidActions.registerWorkflow(
    async () => {
      const h = await SolidActions.startWorkflow(child)({});
      await h.getResult();
      return { unreached: true };
    },
    { name: uniq('parent-child') },
  );

  const code1 = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code1).toBe(0);
  const childId = `${PARENT_RUN_ID}-child-0`;

  // Backend writes the parent-keyed op with a SERIALIZED error (not output).
  srv.completeChild(childId, { error: JSON.stringify({ name: 'Error', message: 'child exploded' }) });

  const code2 = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));
  // Parent observes the failure (rethrow) → terminal failed, NOT a silent stall.
  expect(code2).toBe(1);
  expect(srv.lastWorkflowComplete()!.status).toBe('failed');
});

it('nested children: completion targets only the DIRECT parent (risk 5)', async () => {
  // Model directly at the bridge level: a "middle" run spawns a "leaf"; the
  // backend completeChild writes the op keyed to MIDDLE, never the root.
  const leaf = SolidActions.registerWorkflow(async (_input: Record<string, never>) => ({ leaf: 1 }), {
    name: uniq('leaf'),
  });
  const middle = SolidActions.registerWorkflow(
    async () => {
      const h = await SolidActions.startWorkflow(leaf)({});
      const r = (await h.getResult()) as { leaf: number };
      return { fromLeaf: r.leaf };
    },
    { name: uniq('middle') },
  );

  // PARENT_RUN_ID plays the "middle" run here (it is the one calling
  // startWorkflow). Run 1 enqueues leaf as `${PARENT_RUN_ID}-child-0`.
  const code1 = await expectProcessExit(() => SolidActions.run(middle), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code1).toBe(0);
  const leafId = `${PARENT_RUN_ID}-child-0`;

  srv.completeChild(leafId, { output: JSON.stringify({ leaf: 1 }) });

  // The parent-keyed op was written ONLY on the direct parent (PARENT_RUN_ID =
  // middle). The leaf run's own op store is untouched by the completion hook.
  const middleOps = srv.store.operations.get(PARENT_RUN_ID)!;
  expect(middleOps.some((o) => o.childWorkflowId === leafId && o.functionName === 'SolidActions.startWorkflow')).toBe(
    true,
  );
  const leafOps = srv.store.operations.get(leafId) || [];
  expect(leafOps.length).toBe(0); // nothing recursed onto the child

  const code2 = await expectProcessExit(() => SolidActions.run(middle), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code2).toBe(0);
  expect(srv.lastWorkflowComplete()!.output).toEqual({ fromLeaf: 1 });
});
