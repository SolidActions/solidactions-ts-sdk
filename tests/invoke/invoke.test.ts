/**
 * Tests for invoke() — the per-request workflow runner.
 *
 * Asserted behaviors (Task 1.3):
 *   (a) normal return                 -> { status: 'completed', output }
 *   (b) workflow throw                -> { status: 'failed' } and NOTHING escapes
 *                                        invoke() and NO process.exit is called
 *   (c) ctx.sleep()                   -> { status: 'suspended', reason: 'sleep' }
 *                                        (exercises InvokeSystemDatabase throwing
 *                                        SuspensionRequired)
 *   (d) init/health failure BEFORE    -> { status: 'failed', phase: 'init' }
 *       the workflow body runs           (forced by stopping the mock server so
 *                                        the /health GET genuinely fails)
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */

import { invoke } from '../../src/invoke/invoke';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { __clearRegistry } from '../../src/invoke/registry';
import { setUpSolidActionsTestServer, makeCtx, clearMockServerState } from '../helpers';
import { expectProcessExit, ProcessExitSignal } from './helpers-exit';
import { MockHttpServer, createMockServer } from '../../src/testing/mock_server';

describe('invoke', () => {
  let srv: MockHttpServer;

  beforeAll(async () => {
    srv = await setUpSolidActionsTestServer();
  });

  beforeEach(() => {
    clearMockServerState();
    // T1: defineWorkflow now populates a process-global registry — clear it
    // between cases so workflows with auto-inferred names don't collide.
    __clearRegistry();
  });

  it('completed: normal return maps to { status: completed, output }', async () => {
    const wf = defineWorkflow<{ n: number }, number>({
      run(ctx) {
        return Promise.resolve(ctx.input.n + 1);
      },
    });

    const r = await invoke(wf, makeCtx(srv, { input: { n: 41 } }));

    expect(r).toEqual({ status: 'completed', output: 42 });
  });

  it('failed: a thrown workflow error is caught — nothing escapes invoke(), no process.exit', async () => {
    const wf = defineWorkflow({
      run() {
        return Promise.reject(new Error('boom'));
      },
    });

    // Arm the process.exit interceptor. If invoke() (or anything it calls) hit
    // process.exit, expectProcessExit would resolve to a numeric code; instead
    // invoke() must resolve to a failed result and never call process.exit, so
    // the inner fn completes and expectProcessExit throws "completed without
    // calling process.exit" — which we assert on, proving no exit.
    let exitProbeError: unknown;
    let result: Awaited<ReturnType<typeof invoke>> | undefined;
    try {
      await expectProcessExit(async () => {
        result = await invoke(wf, makeCtx(srv, { input: {} }));
      });
    } catch (err) {
      exitProbeError = err;
    }

    expect(exitProbeError).toBeInstanceOf(Error);
    expect(exitProbeError).not.toBeInstanceOf(ProcessExitSignal);
    expect((exitProbeError as Error).message).toContain('without calling process.exit');

    expect(result).toBeDefined();
    expect(result!.status).toBe('failed');
    if (result!.status === 'failed') {
      expect(result!.phase).toBe('run');
      expect(result!.error).toBeInstanceOf(Error);
      expect((result!.error as Error).message).toBe('boom');
    }
  });

  it('suspended: ctx.sleep() maps to { status: suspended, reason: sleep }', async () => {
    const wf = defineWorkflow({
      async run(ctx) {
        await ctx.sleep(1000);
        return 'never-reached';
      },
    });

    const r = await invoke(wf, makeCtx(srv, { input: {} }));

    expect(r).toEqual({ status: 'suspended', reason: 'sleep' });
  });

  it('failure-before-start: a real init/health failure maps to { status: failed, phase: init }', async () => {
    // Force a GENUINE init failure: a fresh mock server that we stop before
    // invoking, so the InvokeSystemDatabase /health GET hits a refused
    // connection during init — before the workflow body ever runs.
    const deadSrv = await createMockServer();
    const ctx = makeCtx(deadSrv, { input: {} });
    await deadSrv.stop();

    let bodyRan = false;
    const wf = defineWorkflow({
      run() {
        bodyRan = true;
        return Promise.resolve(1);
      },
    });

    const r = await invoke(wf, ctx);

    expect(r).toMatchObject({ status: 'failed', phase: 'init' });
    expect(bodyRan).toBe(false);
  });
});
