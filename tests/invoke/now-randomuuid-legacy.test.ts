/**
 * Regression: SolidActions.now() / randomUUID() still route through
 * SolidActionsExecutor.runInternalStep() on the legacy launch() path
 * (i.e. when SolidActionsExecutor.globalInstance is set).
 *
 * This is the path used by long-running workers, childWorkflowID recording,
 * and the existing 19 jsapi/workflow_input tests. It must be unaffected by
 * the invoke-scope fix in Task 2.
 *
 * Test design:
 *   - Workflows are registered at module scope (before launch()) — the same
 *     pattern as jsapi.test.js. Calling registerWorkflow() after launch()
 *     throws SolidActionsConflictingRegistrationError.
 *   - Uses the established jsapi.test.js pattern: SolidActions.setConfig() +
 *     launch() / shutdown() lifecycle in beforeAll/beforeEach/afterEach.
 *   - Does NOT pre-seed the workflow row — internalWorkflow creates it fresh
 *     (pre-seeding returns shouldExecuteOnThisExecutor: false and skips
 *     execution). Operations verified via SolidActions.listWorkflowSteps().
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
import { randomUUID } from 'node:crypto';
import { setUpSolidActionsTestServer, generateSolidActionsTestConfig } from '../helpers';
import { SolidActions } from '../../src';
import { SolidActionsExecutor } from '../../src/solidactions-executor';
import { MockHttpServer } from '../../src/testing/mock_server';

// ── Module-scope workflow registrations ──────────────────────────────────────
// Must be at module scope: registerWorkflow() throws if called after launch().

let capturedNowMs: number | undefined;
const nowWorkflow = SolidActions.registerWorkflow(
  async () => {
    capturedNowMs = await SolidActions.now();
    return capturedNowMs;
  },
  { name: 'now-legacy-regression' },
);

let capturedUUID: string | undefined;
const uuidWorkflow = SolidActions.registerWorkflow(
  async () => {
    capturedUUID = await SolidActions.randomUUID();
    return capturedUUID;
  },
  { name: 'randomuuid-legacy-regression' },
);

const replayResults: number[] = [];
const nowTwiceWorkflow = SolidActions.registerWorkflow(
  async () => {
    replayResults.length = 0;
    const t1 = await SolidActions.now();
    const t2 = await SolidActions.now();
    replayResults.push(t1, t2);
    return { t1, t2 };
  },
  { name: 'now-twice-legacy-regression' },
);

// ── Test lifecycle ────────────────────────────────────────────────────────────

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
  const config = generateSolidActionsTestConfig();
  SolidActions.setConfig(config);
});

beforeEach(async () => {
  srv.store.clear();
  srv.requestLog.length = 0;
  await SolidActions.launch();
});

afterEach(async () => {
  await SolidActions.shutdown();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

it('globalInstance is set after SolidActions.launch()', () => {
  expect(SolidActionsExecutor.globalInstance).toBeDefined();
  expect(SolidActionsExecutor.globalInstance).toBeInstanceOf(SolidActionsExecutor);
});

it('SolidActions.now() resolves to a number on the legacy executor path and records an operation', async () => {
  // Confirm globalInstance is set — we are on the legacy path, not invoke.
  expect(SolidActionsExecutor.globalInstance).toBeDefined();

  capturedNowMs = undefined;
  const wfid = randomUUID();
  await SolidActions.withNextWorkflowID(wfid, async () => {
    await nowWorkflow();
  });

  expect(typeof capturedNowMs).toBe('number');
  expect(capturedNowMs).toBeGreaterThan(0);

  // Verify the operation was durably recorded by runInternalStep via the
  // legacy executor (not via the invoke-scope primitive bridge).
  const steps = await SolidActions.listWorkflowSteps(wfid);
  expect(steps).toBeDefined();
  const nowStep = steps!.find((s) => s.name === 'SolidActions.now');
  expect(nowStep).toBeTruthy();
});

it('SolidActions.randomUUID() resolves to a UUID string on the legacy executor path and records an operation', async () => {
  expect(SolidActionsExecutor.globalInstance).toBeDefined();

  capturedUUID = undefined;
  const wfid = randomUUID();
  await SolidActions.withNextWorkflowID(wfid, async () => {
    await uuidWorkflow();
  });

  expect(typeof capturedUUID).toBe('string');
  expect(capturedUUID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  const steps = await SolidActions.listWorkflowSteps(wfid);
  expect(steps).toBeDefined();
  const uuidStep = steps!.find((s) => s.name === 'SolidActions.randomUUID');
  expect(uuidStep).toBeTruthy();
});

it('SolidActions.now() records two separate operations when called twice in one workflow (legacy path)', async () => {
  expect(SolidActionsExecutor.globalInstance).toBeDefined();

  const wfid = randomUUID();
  await SolidActions.withNextWorkflowID(wfid, async () => {
    await nowTwiceWorkflow();
  });

  expect(replayResults).toHaveLength(2);
  expect(replayResults[0]).toBeGreaterThan(0);
  expect(replayResults[1]).toBeGreaterThan(0);

  // Two separate durable operations should be recorded (functionId 0 and 1).
  const steps = await SolidActions.listWorkflowSteps(wfid);
  const nowSteps = steps!.filter((s) => s.name === 'SolidActions.now');
  expect(nowSteps).toHaveLength(2);
});
