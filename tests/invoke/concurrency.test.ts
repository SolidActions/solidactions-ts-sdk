/**
 * Task 1.4 — THE CORE PROOF.
 *
 * Concurrency regression: invoke() must NEVER cross-contaminate runtime identity
 * across concurrent invocations. Each invoke() builds a fresh per-request engine
 * whose identity comes strictly from its own `ctx` (no globalParams, no
 * SolidActionsExecutor.globalInstance, no process.env). This test fires N=25
 * invokes simultaneously and proves that every backend HTTP request a run issued
 * carries ONLY that run's identity markers.
 *
 * Two INDEPENDENT on-the-wire identity dimensions are correlated:
 *
 *   Dimension A — workflowID in the URL path
 *       `/runs/status/<runUuid>/operations[/<fid>]` (http_system_database.ts
 *       :211,251). The path workflowID is `ctx.run.runUuid` (invoke.ts:139).
 *       This is the natural run-correlation key.
 *
 *   Dimension B — the `Authorization: Bearer <apiKey>` header
 *       (http_client.ts:196). The bearer is `ctx.api.key`, captured into a
 *       SEPARATE per-request HttpClient instance constructed from the ctx-derived
 *       config (invoke.ts:142-150 -> invoke-system-database.ts:71 -> base ctor
 *       http_system_database.ts:48-58). It does NOT derive from the path — it
 *       flows through an independent object graph.
 *
 * Because A (path) and B (bearer) are produced by independent machinery, a
 * hypothetical global-state leak — e.g. run-i's HTTP call accidentally using a
 * module-global / shared client that still holds run-j's apiKey — would put
 * run-j's bearer on a request whose path says run-i. assertNoIdentityCross-
 * Contamination() correlates every request by its path workflowID and asserts
 * the bearer on that request is EXACTLY the key run-i was constructed with. Such
 * a leak makes A and B disagree and the assertion FAILS. That is why this is a
 * genuine, falsifiable proof and not a tautology.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */

import { invoke } from '../../src/invoke/invoke';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { setUpSolidActionsTestServer, makeCtx, clearMockServerState } from '../helpers';
import { MockHttpServer } from '../../src/testing/mock_server';
import type { InvokeCtx } from '../../src/invoke/types';

const N = 25;

describe('invoke concurrency — identity isolation', () => {
  let srv: MockHttpServer;

  beforeAll(async () => {
    srv = await setUpSolidActionsTestServer();
  });

  beforeEach(() => {
    clearMockServerState();
  });

  it('concurrent invokes never cross-contaminate runtime identity', async () => {
    // A barrier so all N invokes are simultaneously in flight AT the step
    // boundary (the backend GET/POST contention point) before any step body
    // resolves — this is what makes the interleave genuine rather than serial.
    let arrived = 0;
    let releaseAll: () => void = () => {};
    const allArrived = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    const wf = defineWorkflow<{ id: string }, string>({
      run(ctx) {
        return ctx
          .step(
            () => {
              arrived += 1;
              if (arrived === N) {
                releaseAll();
              }
              // Every step waits until ALL N have reached the step — forcing
              // all per-request engines/clients to be live concurrently.
              return allArrived.then(() => 'noop');
            },
            { name: 's' },
          )
          .then(() => ctx.run.runUuid);
      },
    });

    // makeCtx shallow-merges `partial` last (helpers.ts:97), so `run`/`app`/`api`
    // REPLACE the defaults wholesale — each must be a COMPLETE object. Each ctx
    // gets a distinct runUuid (path dimension) AND a distinct api.key (bearer
    // dimension) so the two identity dimensions are independently varied.
    const ctxs: Array<InvokeCtx<{ id: string }>> = Array.from({ length: N }, (_, i) =>
      makeCtx(srv, {
        input: { id: `c${i}` },
        run: {
          triggerId: `trig-${i}`,
          runUuid: `run-${i}`,
          runSecret: `secret-${i}`,
          workerSessionId: `ws-${i}`,
        },
        app: {
          appVersion: `v${i}`,
          appId: `app-${i}`,
          tenantId: `t${i}`,
        },
        api: {
          url: srv.baseUrl,
          key: `key-${i}`,
        },
      }),
    );

    // Seed each run's workflow row in the mock store. The minimal Task 1.3
    // invoke() path does not call initWorkflowStatus (run rows are created by
    // the trigger-dispatch path in a real deployment, not by the SDK's step
    // calls), and the mock's recordOperation 404s for an unknown workflow.
    // Pre-seeding mirrors how every other operation test sets up its row
    // (e.g. http_client.test.ts via initWorkflowStatus) — test setup only;
    // it does NOT alter invoke()/engine or mock behavior.
    ctxs.forEach((c) => {
      srv.store.workflows.set(c.run.runUuid, {
        workflowUUID: c.run.runUuid,
        status: 'PENDING',
        workflowName: '',
        workflowClassName: '',
        workflowConfigName: '',
        authenticatedUser: '',
        assumedRole: '',
        authenticatedRoles: [],
        request: {},
        executorId: String(c.run.triggerId),
        applicationVersion: c.app.appVersion,
        applicationID: c.app.appId,
        input: null,
        output: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        recoveryAttempts: 0,
        priority: 0,
      });
      srv.store.operations.set(c.run.runUuid, []);
    });

    const results = await Promise.all(ctxs.map((c) => invoke(wf, c)));

    // Every invoke completed returning ITS OWN runUuid (no swapped identity in
    // the returned value either).
    results.forEach((r, i) => {
      expect(r).toEqual({ status: 'completed', output: `run-${i}` });
    });

    // THE PROOF: every recorded backend request is identity-consistent for the
    // run named in its path. Throws a precise message if any request carries a
    // foreign bearer (cross-contamination).
    const expectedKeyByRun: Record<string, string> = {};
    ctxs.forEach((_, i) => {
      expectedKeyByRun[`run-${i}`] = `key-${i}`;
    });

    expect(srv.assertNoIdentityCrossContamination(expectedKeyByRun)).toBe(true);

    // Guard: prove the identity assertion above inspected real requests (not a vacuous pass on an empty log).
    // Each invoke runs one ctx.step → at minimum a GET operations + a POST operation = 2 workflow-scoped requests.
    // Uses the same path regex as assertNoIdentityCrossContamination() (/^\/runs\/status\/([^/?]+)/) so the
    // guard and the assertion classify "workflow-scoped" identically.
    expect(srv.requestLog.filter(e => /^\/runs\/status\/([^/?]+)/.test(e.path)).length).toBeGreaterThanOrEqual(N * 2);
  });
});
