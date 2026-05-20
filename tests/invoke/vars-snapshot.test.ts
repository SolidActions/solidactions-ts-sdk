/**
 * Task 3.1 — Snapshot ctx.vars at run start for replay determinism.
 *
 * The CRITICAL replay case (the bug this fixes):
 *
 *   A workflow branches on `ctx.vars.X` BEFORE any completed step:
 *     - first dispatch sees vars.X='A', branch goes 'path-A', workflow suspends
 *     - between dispatches the adapter-supplied env var changes to vars.X='B'
 *     - replay must re-execute the same branch and reach the SAME cached step;
 *       without a vars snapshot, the branch evaluates 'path-B' on replay →
 *       divergence → cached step result no longer matches → wrong output.
 *
 * The fix: capture `ctx.vars` on the FIRST dispatch (write-once onto the run
 * record alongside `input`), and on every subsequent dispatch construct
 * `ctx.vars` from the snapshot, IGNORING the adapter-supplied current values.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
import { invoke } from '../../src/invoke/invoke';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { __clearRegistry } from '../../src/invoke/registry';
import { setUpSolidActionsTestServer, makeCtx, clearMockServerState } from '../helpers';
import { MockHttpServer } from '../../src/testing/mock_server';

describe('Task 3.1 — ctx.vars snapshot replay-determinism', () => {
  let srv: MockHttpServer;

  beforeAll(async () => {
    srv = await setUpSolidActionsTestServer();
  });

  beforeEach(() => {
    clearMockServerState();
    __clearRegistry();
  });

  it('replay uses run-start vars snapshot even if the var changed between dispatches', async () => {
    // A workflow that branches on ctx.vars.MODE BEFORE any completed step,
    // then records via a step (s1), then suspends via sleep.
    const wf = defineWorkflow<unknown, string>({
      async run(ctx) {
        const branch = (ctx.vars.MODE as string) === 'A' ? 'path-A' : 'path-B';
        await ctx.step(() => branch, { name: 's1' });
        await ctx.sleep(1000); // suspend
        return branch;
      },
    });

    // Pre-seed the parent run row (the trigger-dispatch path creates it before
    // the one-shot process starts — mirrors run-compat.test.ts). The step's
    // operations POST and the sleep POST need the row to exist.
    const RUN_ID = '00000000-0000-4000-8000-00000000abcd';
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
      applicationID: 'test-app',
      input: null,
      output: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      recoveryAttempts: 0,
      priority: 0,
    });
    srv.store.operations.set(RUN_ID, []);

    // ---- Dispatch 1: MODE='A' --------------------------------------------------
    // Same run uuid will be used on both dispatches (replay semantics).
    const c1 = makeCtx<unknown>(srv, {
      input: {},
      vars: { MODE: 'A' },
      run: {
        triggerId: 'test-trigger',
        runUuid: RUN_ID,
        runSecret: 'test-run-secret',
        workerSessionId: 'test-worker-session',
      },
    });
    const r1 = await invoke(wf, c1);
    expect(r1).toEqual({ status: 'suspended', reason: 'sleep' });

    // ---- Dispatch 2 (replay): MODE='B' (adapter changed; snapshot must win) ---
    // Same run record (same runUuid) — supply different vars to simulate the env
    // changing between dispatches; the snapshot from dispatch 1 must override.
    // Also satisfy the sleep wakeup so the suspend resolves and the workflow
    // returns. The sleep op was recorded with wakeupTime=now+1000 on dispatch 1;
    // pre-rewrite that op so wakeupTime is in the past — the durableSleepms
    // resume branch then continues without re-suspending. This mirrors how the
    // existing invoke tests handle sleep resume (no scheduler in the test
    // harness; the resume condition is "wakeupTime passed").
    const c2 = makeCtx<unknown>(srv, {
      input: {},
      vars: { MODE: 'B' },
      run: c1.run, // same run uuid → replay
    });
    // Seed the sleep op (functionID=1; functionID=0 is the step s1) as the
    // scheduler would have recorded it on dispatch 1's POST /sleep — with a
    // wakeupTime in the PAST so the resume path completes the sleep and the
    // workflow returns. The mock's /sleep route doesn't auto-store (the real
    // backend's sleep-scheduler writes the op), so we insert it here to model
    // "scheduler wrote the op + wakeup time passed".
    const ops = srv.store.operations.get(RUN_ID)!;
    ops.push({
      workflowUUID: RUN_ID,
      functionId: 1,
      functionName: 'SolidActions.sleep',
      output: JSON.stringify({ wakeupTime: Date.now() - 1 }),
      error: null,
    });

    const r2 = await invoke(wf, c2);

    // CRITICAL: replay must see 'A' (snapshot), not 'B' (current adapter).
    expect(r2).toEqual({ status: 'completed', output: 'path-A' });

    // s1 was invoked exactly once across the two dispatches (replayed from
    // cache on dispatch 2). Count POST /runs/status/<id>/operations with the
    // step's function name in the body to determine actual step invocations
    // (vs. cached replays which do not POST).
    const stepPosts = srv.requestLog.filter(
      (e) =>
        e.method === 'POST' &&
        /\/(?:runs\/status|workflows)\/[^/]+\/operations$/.test(e.path) &&
        (e.body as { functionName?: string } | undefined)?.functionName === 's1',
    );
    expect(stepPosts.length).toBe(1);
  });
});
