/**
 * Task 2.3 — run() as the one-shot compat layer.
 *
 * Proves the rewritten SolidActions.run() routes a legacy-registered workflow
 * through the new path (oneShotContextAdapter -> invoke() -> oneShotRuntimeAdapter):
 *  - completed  -> process.exit(0), completion POSTed with output + status
 *  - throwing   -> process.exit(1), completion POSTed with failed status
 *  - sleep      -> suspension via the one-shot adapter -> process.exit(0) + a
 *                  scheduled sleep observed on the mock
 *
 * Pointing the SDK at the mock:
 *   setUpSolidActionsTestServer() only starts the in-memory mock and returns it;
 *   it does NOT wire the SDK to it. The new run() builds ctx via
 *   oneShotContextAdapter(process.env), which maps SOLIDACTIONS_API_URL ->
 *   ctx.api.url, SOLIDACTIONS_API_KEY -> ctx.api.key, and SOLIDACTIONS_RUN_ID ->
 *   ctx.run.runUuid (the workflow id used in the completion/sleep POST paths).
 *   So the test sets exactly those three keys (plus WORKFLOW_INPUT from the spec)
 *   via expectProcessExit's env arg, which snapshots/restores them. This is the
 *   minimal env needed to (a) reach the mock and (b) give the run a stable id the
 *   read-only accessors can correlate.
 */
/* eslint-disable @typescript-eslint/require-await --
 * The workflow fixtures below are intentionally `async` (matching the
 * registerWorkflow / one-shot run() contract) even when their bodies have no
 * await — that is the shape under test, not a mistake. */
import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import { MockHttpServer } from '../../src/testing/mock_server';

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

/** The run id the one-shot ContextAdapter maps to ctx.run.runUuid. */
const RUN_ID = '00000000-0000-4000-8000-0000000003';

beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;

  // Pre-seed the run row, exactly as the prior invoke() concurrency regression
  // does (tests/invoke/concurrency.test.ts). In a real deployment the trigger-
  // dispatch path creates the run row BEFORE the one-shot process starts; the
  // invoke() engine deliberately never calls initWorkflowStatus (see
  // src/invoke/invoke.ts header), and the mock's recordOperation 404s for an
  // unknown workflow. This is test setup only — it does NOT alter run(),
  // invoke()/engine, or mock behavior.
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

it('completed workflow → exit 0, output POSTed, status=completed', async () => {
  const wf = SolidActions.registerWorkflow(async (input: { n: number }) => input.n * 2, {
    name: 'run-compat-completed',
  });
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    mockEnv({ WORKFLOW_INPUT: JSON.stringify({ n: 21 }) }),
  );
  expect(code).toBe(0);
  expect(srv.lastWorkflowComplete()!.output).toEqual(42);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
});

it('throwing workflow → exit 1, status=failed', async () => {
  const wf = SolidActions.registerWorkflow(
    async () => {
      throw new Error('boom');
    },
    { name: 'run-compat-throwing' },
  );
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code).toBe(1);
  expect(srv.lastWorkflowComplete()!.status).toBe('failed');
});

it('sleep → exit 0 + sleep scheduled (suspension via one-shot adapter)', async () => {
  const wf = SolidActions.registerWorkflow(
    async () => {
      await SolidActions.runStep(() => 'step-A');
      await SolidActions.sleepms(60_000);
      return 'after-sleep';
    },
    { name: 'run-compat-sleep' },
  );
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));
  expect(code).toBe(0);
  expect(srv.lastSleepSchedule()).toBeTruthy();
});
