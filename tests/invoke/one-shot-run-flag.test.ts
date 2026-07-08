/**
 * Task 1 of solidactions-app#414 — the one-shot run-started record.
 *
 * `SolidActions.run()`'s one-shot path records `{ workflowName }`
 * SYNCHRONOUSLY (before any lazy `require()`/`await`) into a module-global
 * slot exposed via `__getStartedOneShotRun()`. Task 2's launcher guard reads
 * this after `await import(entryFile)` to detect a legacy self-invoking
 * tenant module (one whose top-level `runIfEntrypoint()` already started a
 * run) and defer instead of starting a concurrent second run — the root
 * cause of the empty-`ctx.vars` double-run bug.
 *
 * Harness idioms (mockEnv/seedRun/expectProcessExit/fixture import) are
 * copied verbatim from `launcher.test.ts`'s paired-parity setup — no new
 * mocks.
 */
import * as nodePath from 'node:path';

import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import { __getRegisteredWorkflow } from '../../src/invoke/registry';
import { MockHttpServer } from '../../src/testing/mock_server';
import { __getStartedOneShotRun, __resetStartedOneShotRunForTests } from '../../src/solidactions';

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

/** Absolute path to a fixture file (ts-jest resolves .ts on dynamic import). */
function fixturePath(basename: string): string {
  return nodePath.resolve(__dirname, 'fixtures', basename);
}

/** Pre-seed the run row + ops slot, mirroring launcher.test.ts's seedRun. */
function seedRun(runId: string): void {
  srv.store.workflows.set(runId, {
    workflowUUID: runId,
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
  srv.store.operations.set(runId, []);
}

function mockEnv(runId: string, extra: Record<string, string>): Record<string, string> {
  return {
    SOLIDACTIONS_API_URL: srv.baseUrl,
    SOLIDACTIONS_API_KEY: 'test-api-key',
    SOLIDACTIONS_RUN_ID: runId,
    ...extra,
  };
}

beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;
  __resetStartedOneShotRunForTests();
});

describe('one-shot run-started record', () => {
  it('is null before any run and records the workflow name when run() starts a one-shot run', async () => {
    expect(__getStartedOneShotRun()).toBeNull();

    const RUN_ID = '00000000-0000-4000-8000-0000000000f1';
    seedRun(RUN_ID);
    await import(fixturePath('launcher-completed.ts'));
    const wf = __getRegisteredWorkflow('launcher-completed');
    if (!wf) {
      throw new Error("Test setup: fixture launcher-completed.ts did not register 'launcher-completed'");
    }

    const exit = await expectProcessExit(
      () => SolidActions.run(wf),
      mockEnv(RUN_ID, { WORKFLOW_INPUT: JSON.stringify({ n: 21 }) }),
    );
    expect(exit).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any(String)'s jest typing is `any`
    expect(__getStartedOneShotRun()).toEqual({ workflowName: expect.any(String) });
  });

  it('is recorded synchronously before the context adapter runs', async () => {
    const RUN_ID = '00000000-0000-4000-8000-0000000000f2';
    seedRun(RUN_ID);
    await import(fixturePath('launcher-completed.ts'));
    const wf = __getRegisteredWorkflow('launcher-completed');
    if (!wf) {
      throw new Error("Test setup: fixture launcher-completed.ts did not register 'launcher-completed'");
    }

    // Arm the process.exit interceptor + env exactly like expectProcessExit
    // does, but inline: we need to inspect state BETWEEN calling run() and
    // awaiting it, which expectProcessExit's fn-wrapper (await-then-return)
    // does not expose.
    const g = globalThis as Record<string, unknown>;
    const priorArmed = g.__processExitArmed;
    g.__processExitArmed = true;
    const env = mockEnv(RUN_ID, { WORKFLOW_INPUT: JSON.stringify({ n: 1 }) });
    const priorEnv: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
      priorEnv[key] = process.env[key];
      process.env[key] = env[key];
    }

    try {
      const p = SolidActions.run(wf); // not awaited yet
      expect(__getStartedOneShotRun()).not.toBeNull();
      await p.catch(() => {});
    } finally {
      g.__processExitArmed = priorArmed;
      for (const key of Object.keys(env)) {
        if (priorEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = priorEnv[key];
        }
      }
    }
  });
});
