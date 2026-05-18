/**
 * Task 2.8 — cancellation semantics for the one-shot invoke() path.
 *
 * Phase-2 e2e hardening/cancel found: a sleep-workflow cancelled mid-sleep ended
 * with run_status.status = 'SUCCESS' instead of 'CANCELLED' under the rewritten
 * one-shot path. Root cause: the legacy SolidActionsExecutor explicitly caught
 * SolidActionsWorkflowCancelledError and set internalStatus.status =
 * StatusString.CANCELLED (src/solidactions-executor.ts:606-611, then re-threw,
 * propagating to legacy run()'s catch → process.exit(1)). The rewritten
 * invoke() path caught the body error generically → { status: 'failed' } (or, on
 * a resumed run, wrote SUCCESS), and #reportOneShotTerminalState had no
 * cancelled branch.
 *
 * Legacy behavior mirrored byte-for-byte:
 *   - status value : StatusString.CANCELLED ('CANCELLED')
 *   - exit code    : 1 (legacy run()'s generic catch → process.exit(1); the
 *                    executor re-threw SolidActionsWorkflowCancelledError, it was
 *                    NOT a special exit-0 path)
 *   - endpoint     : the executor's cancelled-self branch only set
 *                    internalStatus.status = CANCELLED and re-threw — it did
 *                    NOT call recordWorkflowError or reportWorkflowComplete. The
 *                    backend row reached CANCELLED via the cancel itself
 *                    (sysdb.cancelWorkflow / the admin cancel endpoint). The
 *                    one-shot terminal-state write therefore PUTs
 *                    /runs/status/<id>/output with { status: CANCELLED } and NO
 *                    output/error payload, and emits NO workflow-complete POST
 *                    (legacy reportWorkflowComplete only takes completed|failed
 *                    and was never reached on the cancelled-self path).
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
import { invoke } from '../../src/invoke/invoke';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { oneShotRuntimeAdapter } from '../../src/invoke/runtime-adapter';
import { SolidActionsWorkflowCancelledError } from '../../src/error';
import { StatusString } from '../../src/workflow';
import { setUpSolidActionsTestServer, makeCtx, clearMockServerState } from '../helpers';
import { expectProcessExit } from './helpers-exit';
import { SolidActions } from '../../src';
import { MockHttpServer } from '../../src/testing/mock_server';

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

describe('invoke() — cancellation mapping', () => {
  beforeEach(() => {
    clearMockServerState();
  });

  it('cancelled: a SolidActionsWorkflowCancelledError thrown from the body maps to { status: cancelled } (NOT failed)', async () => {
    const ctx = makeCtx(srv, { input: {} });
    const wf = defineWorkflow({
      run() {
        // The real CancelledError class — exactly what
        // getOperationResultAndThrowIfCancelled throws when the run row is
        // CANCELLED (src/http_system_database.ts:221) and what the sleep/recv
        // resume path surfaces.
        return Promise.reject(new SolidActionsWorkflowCancelledError(ctx.run.runUuid));
      },
    });

    const r = await invoke(wf, ctx);

    // Pre-fix this is { status: 'failed', phase: 'run', error: <CancelledError> }.
    expect(r).toEqual({ status: 'cancelled' });
  });

  it('cancelled: a sleep-workflow cancelled mid-sleep throws CancelledError from the resume sleep path → { status: cancelled }', async () => {
    // The exact Phase-2 hardening/cancel scenario: a workflow that sleeps,
    // cancelled mid-sleep, then RESUMED. On resume, durableSleepms() calls
    // getOperationResultAndThrowIfCancelled(workflowID, functionID) FIRST; the
    // sleep op was already recorded on the first (suspended) invocation, so the
    // mock's getOperation finds it and returns cancelled:true (run row is
    // CANCELLED), and the engine throws SolidActionsWorkflowCancelledError
    // BEFORE the resume can complete the sleep. (A FRESH sleep with no recorded
    // op suspends — that is not the cancel scenario; the cancel is observed on
    // the resume, where the op exists.)
    const ctx = makeCtx(srv, { input: {} });
    // Seed the run row as already CANCELLED (the cancel landed while the run
    // was suspended mid-sleep — what the e2e hardening/cancel race produces).
    srv.store.workflows.set(ctx.run.runUuid, {
      workflowUUID: ctx.run.runUuid,
      status: StatusString.CANCELLED,
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
    // Pre-record the sleep op (functionID 0 — the first nextFunctionID() of
    // this workflow) as it was on the FIRST, suspended invocation: a recorded
    // durable-sleep with a future wakeupTime. On resume durableSleepms() finds
    // this op via getOperationResultAndThrowIfCancelled, which sees the run row
    // is CANCELLED → throws SolidActionsWorkflowCancelledError.
    srv.store.operations.set(ctx.run.runUuid, [
      {
        workflowUUID: ctx.run.runUuid,
        functionId: 0,
        functionName: 'SolidActions.sleep',
        output: JSON.stringify({ wakeupTime: Date.now() + 60_000 }),
        error: null,
      },
    ]);

    const wf = defineWorkflow({
      async run(c) {
        await c.sleep(60_000);
        return 'after-sleep';
      },
    });

    const r = await invoke(wf, ctx);

    // Pre-fix: { status: 'failed' } (the CancelledError fell through the
    // generic body catch).
    expect(r).toEqual({ status: 'cancelled' });
  });

  it('failed (regression guard): a plain Error still maps to failed, not cancelled', async () => {
    const wf = defineWorkflow({
      run() {
        return Promise.reject(new Error('boom'));
      },
    });

    const r = await invoke(wf, makeCtx(srv, { input: {} }));

    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.phase).toBe('run');
      expect((r.error as Error).message).toBe('boom');
    }
  });
});

describe('oneShotRuntimeAdapter.exitCodeFor — cancelled', () => {
  it('cancelled → 1 (legacy: SolidActionsWorkflowCancelledError re-thrown → run() catch → process.exit(1))', () => {
    expect(oneShotRuntimeAdapter.exitCodeFor({ status: 'cancelled' })).toBe(1);
  });

  it('regression: completed→0, failed→1, suspended→0 unchanged', () => {
    expect(oneShotRuntimeAdapter.exitCodeFor({ status: 'completed', output: 1 })).toBe(0);
    expect(oneShotRuntimeAdapter.exitCodeFor({ status: 'failed', error: 'x' })).toBe(1);
    expect(oneShotRuntimeAdapter.exitCodeFor({ status: 'suspended', reason: 'sleep' })).toBe(0);
  });
});

describe('SolidActions.run() — one-shot CANCELLED terminal state', () => {
  /** The run id the one-shot ContextAdapter maps to ctx.run.runUuid. */
  const RUN_ID = '00000000-0000-4000-8000-000000000280';

  beforeEach(() => {
    srv.store.clear();
    srv.requestLog.length = 0;
  });

  function mockEnv(extra: Record<string, string>): Record<string, string> {
    return {
      SOLIDACTIONS_API_URL: srv.baseUrl,
      SOLIDACTIONS_API_KEY: 'test-api-key',
      SOLIDACTIONS_RUN_ID: RUN_ID,
      ...extra,
    };
  }

  it('cancelled sleep run (resumed) → PUT /runs/status/<id>/output { status: CANCELLED } (no output/error), NO workflow-complete POST, exit 1; the run row stays CANCELLED (NOT SUCCESS/ERROR)', async () => {
    // Pre-seed the run row as already CANCELLED (the cancel landed while the
    // run was suspended mid-sleep — the e2e hardening/cancel race). The sleep
    // op was already recorded on the first (suspended) invocation; on this
    // RESUME invocation durableSleepms() finds it and
    // getOperationResultAndThrowIfCancelled sees the CANCELLED row → throws.
    // #initOneShotStatusRow's POST /runs/status is idempotent for an existing
    // row (mock createWorkflow returns the existing status, does NOT reset it),
    // so the row stays CANCELLED through the body.
    srv.store.workflows.set(RUN_ID, {
      workflowUUID: RUN_ID,
      status: StatusString.CANCELLED,
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
    // Pre-record the sleep op (functionID 0 — the first nextFunctionID() of
    // this workflow) as it was on the FIRST, suspended invocation.
    srv.store.operations.set(RUN_ID, [
      {
        workflowUUID: RUN_ID,
        functionId: 0,
        functionName: 'SolidActions.sleep',
        output: JSON.stringify({ wakeupTime: Date.now() + 60_000 }),
        error: null,
      },
    ]);

    const wf = SolidActions.registerWorkflow(async () => {
      await SolidActions.sleepms(60_000);
      return 'after-sleep';
    });

    const code = await expectProcessExit(
      () => SolidActions.run(wf),
      mockEnv({ WORKFLOW_INPUT: '{}' }),
    );

    // Legacy: SolidActionsWorkflowCancelledError re-thrown → run() catch →
    // process.exit(1). Pre-fix this is 0 (mapped to suspended) or the run
    // recorded SUCCESS.
    expect(code).toBe(1);

    // The CANCELLED terminal-state write is the durable output PUT carrying
    // status: CANCELLED and NO output/error payload (legacy executor set
    // internalStatus.status = CANCELLED only; it did NOT call
    // recordWorkflowError or reportWorkflowComplete).
    const outputPut = srv.lastOutputPut();
    expect(outputPut).toBeTruthy();
    expect(outputPut!.workflowID).toBe(RUN_ID);
    expect(outputPut!.body.status).toBe(StatusString.CANCELLED);
    expect(outputPut!.body.output).toBeNull();

    // NOT a SUCCESS/ERROR write (the bug) and NO error PUT.
    expect(outputPut!.body.status).not.toBe(StatusString.SUCCESS);
    expect(srv.lastErrorPut()).toBeUndefined();

    // NO workflow-complete POST (legacy reportWorkflowComplete only takes
    // completed|failed and was never reached on the cancelled-self path).
    expect(srv.lastWorkflowCompleteIndex()).toBeUndefined();

    // The run row remains CANCELLED — the late terminal PUT did NOT clobber it
    // to SUCCESS/ERROR (backend-guard parity via the mock).
    expect(srv.store.workflows.get(RUN_ID)!.status).toBe(StatusString.CANCELLED);
  });

  it('backend-guard parity (mock): a SUCCESS output PUT arriving AFTER a CANCELLED row does not overwrite CANCELLED', async () => {
    // The real RunStatusController guard: recordOutput/recordError must not
    // overwrite an already-CANCELLED row with SUCCESS/ERROR (a late output/error
    // PUT from a workflow that finished racing the cancel must not clobber
    // CANCELLED). The mock models the same status-transition guard so this half
    // is provable here; the real e2e hardening/cancel validates it end-to-end.
    srv.store.workflows.set(RUN_ID, {
      workflowUUID: RUN_ID,
      status: StatusString.CANCELLED,
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

    // Simulate the racing late SUCCESS PUT over real HTTP against the mock
    // (the mock has no public synchronous route entry; it serves over HTTP).
    const res = await fetch(`${srv.baseUrl}/runs/status/${RUN_ID}/output`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ output: '"late"', status: StatusString.SUCCESS }),
    });

    // The guard rejects the overwrite: row stays CANCELLED (mirrors the real
    // RunStatusController.recordOutput CANCELLED guard).
    expect(res.status).toBe(409);
    expect(srv.store.workflows.get(RUN_ID)!.status).toBe(StatusString.CANCELLED);
  });
});
