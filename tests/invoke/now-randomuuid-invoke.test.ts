/**
 * Regression tests for SolidActions.now() / randomUUID() on the invoke() path.
 *
 * Issue: runInternalStep() dereferences SolidActionsExecutor.globalInstance!
 * which is undefined on the invoke path — crash: "Cannot read properties of
 * undefined (reading 'runInternalStep')".
 *
 * Fix: now()/randomUUID() check getCurrentPrimitives() first and run their
 * callbacks through the invoke-scope step primitive (record-or-replay) when
 * globalInstance is unset.
 */
import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import { MockHttpServer } from '../../src/testing/mock_server';
import { SolidActionsJSON } from '../../src/serialization';

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

const RUN_ID = '00000000-0000-4000-8000-000000000now';

beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;
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

function mockEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    SOLIDACTIONS_API_URL: srv.baseUrl,
    SOLIDACTIONS_API_KEY: 'test-api-key',
    SOLIDACTIONS_RUN_ID: RUN_ID,
    ...extra,
  };
}

it('SolidActions.now() works at workflow scope under invoke() with globalInstance unset', async () => {
  let capturedMs: number | undefined;
  const wf = SolidActions.registerWorkflow(
    async () => {
      capturedMs = await SolidActions.now();
      return capturedMs;
    },
    { name: 'now-invoke-scope' },
  );

  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  expect(typeof capturedMs).toBe('number');
  expect(capturedMs).toBeGreaterThan(0);

  // now() must record an operation (record-or-replay idempotency)
  const ops = srv.store.operations.get(RUN_ID) ?? [];
  const nowOp = ops.find((op) => op.functionName === 'SolidActions.now');
  expect(nowOp).toBeTruthy();
  expect(SolidActionsJSON.parse(nowOp!.output ?? 'null')).toBe(capturedMs);
});

it('SolidActions.randomUUID() works at workflow scope under invoke() with globalInstance unset', async () => {
  let capturedUUID: string | undefined;
  const wf = SolidActions.registerWorkflow(
    async () => {
      capturedUUID = await SolidActions.randomUUID();
      return capturedUUID;
    },
    { name: 'randomuuid-invoke-scope' },
  );

  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  expect(typeof capturedUUID).toBe('string');
  // UUID v4 format
  expect(capturedUUID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  // randomUUID() must record an operation
  const ops = srv.store.operations.get(RUN_ID) ?? [];
  const uuidOp = ops.find((op) => op.functionName === 'SolidActions.randomUUID');
  expect(uuidOp).toBeTruthy();
  expect(SolidActionsJSON.parse(uuidOp!.output ?? 'null')).toBe(capturedUUID);
});

it('SolidActions.now() replays from recorded operation on second invoke (determinism)', async () => {
  // Pre-seed a recorded now() operation so the second invoke replays it
  const recordedMs = 1_700_000_000_000;
  srv.store.operations.set(RUN_ID, [
    {
      workflowUUID: RUN_ID,
      functionId: 0,
      functionName: 'SolidActions.now',
      output: SolidActionsJSON.stringify(recordedMs) ?? String(recordedMs),
      error: null,
    },
  ]);

  let capturedMs: number | undefined;
  const wf = SolidActions.registerWorkflow(
    async () => {
      capturedMs = await SolidActions.now();
      return capturedMs;
    },
    { name: 'now-invoke-replay' },
  );

  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  // Must replay the recorded value, not call Date.now() again
  expect(capturedMs).toBe(recordedMs);
});
