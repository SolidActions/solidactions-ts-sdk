/**
 * Task 2.5 — WORKFLOW_SLUG dispatch guard on the one-shot run() path.
 *
 * The one-shot contract evaluates a deployed workflow's entrypoint module which
 * calls top-level `SolidActions.run(wf)`. A parent that `import`s a child whose
 * own module has a top-level `run(childTask)` would, WITHOUT this guard, run the
 * CHILD body against the PARENT's input (Node fully evaluates the imported
 * module — including its top-level `run()` — before the importer's body). The
 * guard compares the registered workflow identity against the WORKFLOW_SLUG env
 * the app injects (RuntimeEnvBuilder) and makes the non-matching `run()` an
 * inert no-op, while a true entrypoint/deploy misconfig (NOTHING ever matches)
 * trips a loud non-zero exit instead of a silent never-runs hang.
 *
 * This suite proves:
 *  1. match     → run(wf) invokes the body (output PUT observed on the mock).
 *  2. mismatch  → run(wf) does NOT invoke, does NOT write a status row, does NOT
 *                 process.exit(), and its promise RESOLVES; a SUBSEQUENT run()
 *                 whose name matches the env DOES invoke (import-then-entrypoint
 *                 sequence works in one process).
 *  3. absent    → no WORKFLOW_SLUG → behavior identical to today (invokes) AND
 *                 the diagnostic Set is NOT mutated (Defect B — strict legacy
 *                 parity: the absent/empty path does ZERO extra work).
 *  4. fail-loud → the pure __shouldFailLoudOnExit decision is exhaustively
 *                 tested (the process.on('exit') handler is wired to it), and
 *                 __failLoudExitCode never clobbers an existing non-zero exit
 *                 code (Defect C).
 *  5. fail-safe → an UNIDENTIFIABLE defineWorkflow({ run }) entrypoint (no
 *                 registration name, no fn .name) with a non-empty
 *                 WORKFLOW_SLUG STILL invokes its body — it is never silently
 *                 no-opped (Defect A — the catastrophic over-block).
 *  6. transparent match → the match path with WORKFLOW_SLUG present writes the
 *                 full status/output flow undisturbed (Codex #7).
 *
 * Mock wiring mirrors run-statusrow.test.ts / run-compat.test.ts.
 */
/* eslint-disable @typescript-eslint/require-await --
 * The workflow fixtures are intentionally `async` (matching the one-shot run()
 * contract) even when their bodies have no await — that is the shape under
 * test, not a mistake. */
import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import {
  __shouldFailLoudOnExit,
  __normalizeSlug,
  __failLoudExitCode,
  __runWorkflowNamesSeenSize,
} from '../../src/solidactions';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { MockHttpServer } from '../../src/testing/mock_server';
import { SolidActionsJSON } from '../../src/serialization';

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

/** The run id the one-shot ContextAdapter maps to ctx.run.runUuid. */
const RUN_ID = '00000000-0000-4000-8000-0000000002f0';

beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;

  // Pre-seed the run row exactly as run-statusrow.test.ts does. In a real
  // deployment the trigger-dispatch path creates the row before the one-shot
  // process starts; this keeps the match/absent cases focused on whether the
  // body ran (output PUT) vs. the guard short-circuiting before any write.
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

it('match → WORKFLOW_SLUG equals the registered name → run(wf) invokes the body and PUTs the output', async () => {
  // setup
  const wf = SolidActions.registerWorkflow(async (input: { n: number }) => input.n * 2, {
    name: 'child-task',
  });

  // action
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    mockEnv({ WORKFLOW_SLUG: 'child-task', WORKFLOW_INPUT: JSON.stringify({ n: 21 }) }),
  );

  // assert: the body ran — exit 0, the durable output PUT happened with the
  // SolidActionsJSON-serialized result, and the run row reflects it.
  expect(code).toBe(0);
  const outputPut = srv.lastOutputPut();
  expect(outputPut).toBeTruthy();
  expect(outputPut!.workflowID).toBe(RUN_ID);
  expect(outputPut!.body.status).toBe('SUCCESS');
  expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(42);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
});

it('mismatch → run(wf) is an inert no-op (no invoke, no status row, no process.exit, promise RESOLVES); a subsequent matching run() still invokes', async () => {
  // setup: imported-child shape — env names the PARENT (`parent-child`) but the
  // imported child module's top-level call is run(childTask).
  const childTask = SolidActions.registerWorkflow(
    async (_input: unknown) => 'child-ran',
    { name: 'imported-child' },
  );
  const parentChild = SolidActions.registerWorkflow(
    async (input: { n: number }) => input.n + 100,
    { name: 'entrypoint-parent' },
  );

  // action 1: the imported child's top-level run() — env slug is the PARENT.
  // It must NOT throw, NOT call process.exit, and RESOLVE cleanly. We arm the
  // process.exit interceptor so an erroneous exit would be observable as a
  // thrown ProcessExitSignal (caught here → test failure).
  const g = globalThis as Record<string, unknown>;
  const priorArmed = g.__processExitArmed;
  const priorSlug = process.env.WORKFLOW_SLUG;
  const priorInput = process.env.WORKFLOW_INPUT;
  const priorUrl = process.env.SOLIDACTIONS_API_URL;
  const priorKey = process.env.SOLIDACTIONS_API_KEY;
  const priorRunId = process.env.SOLIDACTIONS_RUN_ID;
  g.__processExitArmed = true;
  process.env.WORKFLOW_SLUG = 'entrypoint-parent';
  process.env.WORKFLOW_INPUT = JSON.stringify({ n: 5 });
  process.env.SOLIDACTIONS_API_URL = srv.baseUrl;
  process.env.SOLIDACTIONS_API_KEY = 'test-api-key';
  process.env.SOLIDACTIONS_RUN_ID = RUN_ID;

  try {
    let resolved = false;
    await SolidActions.run(childTask).then(() => {
      resolved = true;
    });
    // The mismatched run() resolved cleanly (no throw / no ProcessExitSignal).
    expect(resolved).toBe(true);

    // No invoke happened: no output PUT, no error PUT, no workflow-complete POST.
    expect(srv.lastOutputPut()).toBeUndefined();
    expect(srv.lastErrorPut()).toBeUndefined();
    expect(srv.lastWorkflowCompleteIndex()).toBeUndefined();
    // No status-row create was attempted by the skipped run().
    expect(srv.lastRunStatusCreate()).toBeUndefined();

    // action 2: the entrypoint's OWN matching run() (same process) DOES invoke.
    await expect(SolidActions.run(parentChild)).rejects.toMatchObject({
      name: 'ProcessExitSignal',
      code: 0,
    });

    // assert: the parent body ran — output PUT present with 5 + 100 = 105.
    const outputPut = srv.lastOutputPut();
    expect(outputPut).toBeTruthy();
    expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(105);
    expect(srv.lastWorkflowComplete()!.status).toBe('completed');
  } finally {
    g.__processExitArmed = priorArmed;
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    };
    restore('WORKFLOW_SLUG', priorSlug);
    restore('WORKFLOW_INPUT', priorInput);
    restore('SOLIDACTIONS_API_URL', priorUrl);
    restore('SOLIDACTIONS_API_KEY', priorKey);
    restore('SOLIDACTIONS_RUN_ID', priorRunId);
  }
});

it('Defect A fail-safe → an UNIDENTIFIABLE defineWorkflow({ run }) entrypoint with a non-empty WORKFLOW_SLUG STILL invokes its body (never silently no-opped)', async () => {
  // setup: a `defineWorkflow({ run })` descriptor carries NO registration name
  // and no function `.name` — its identity is UNKNOWN. This is the shape of a
  // legitimate single-workflow ENTRYPOINT under the one-shot contract. With a
  // non-empty WORKFLOW_SLUG set, the OLD guard computed `wfName === ''`,
  // `norm('') !== norm(slug)` → treated the entrypoint's OWN workflow as a
  // mismatch and no-opped it → the dispatched run never ran → hang until
  // timeout. The fail-safe fix must run it anyway (favor running the
  // entrypoint over silently hanging it).
  let bodyRan = false;
  const wf = defineWorkflow<{ n: number }, number>({
    run: async (ctx) => {
      bodyRan = true;
      return ctx.input.n * 3;
    },
  });

  // action: WORKFLOW_SLUG is a non-empty, definitely-non-matching slug. The
  // pre-fix guard would no-op (bodyRan stays false, no output PUT, hang).
  const code = await expectProcessExit(
    () => SolidActions.run(wf, { input: { n: 7 } }),
    mockEnv({ WORKFLOW_SLUG: 'some-deployed-slug', WORKFLOW_INPUT: JSON.stringify({ n: 7 }) }),
  );

  // assert: the body fully executed (NOT no-opped) — exit 0, body ran, the
  // durable output PUT happened with 7 * 3 = 21, run row completed.
  expect(code).toBe(0);
  expect(bodyRan).toBe(true);
  const outputPut = srv.lastOutputPut();
  expect(outputPut).toBeTruthy();
  expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(21);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
});

it('absent key → no WORKFLOW_SLUG in env → behavior identical to today (run() invokes the body unguarded) AND the diagnostic Set is NOT mutated', async () => {
  // setup: no WORKFLOW_SLUG at all — the legacy path must be byte-identical.
  // Defect B: the absent/empty path must do ZERO extra work — no diagnostic
  // Set mutation, no flags, no handler. Snapshot the Set size before the run.
  const wf = SolidActions.registerWorkflow(async (input: { n: number }) => input.n - 1, {
    name: 'legacy-workflow',
  });
  const seenSizeBefore = __runWorkflowNamesSeenSize();

  // action
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    mockEnv({ WORKFLOW_INPUT: JSON.stringify({ n: 10 }) }),
  );

  // assert: invoked exactly as before the guard existed.
  expect(code).toBe(0);
  const outputPut = srv.lastOutputPut();
  expect(outputPut).toBeTruthy();
  expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(9);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');

  // assert (Defect B): the absent-key path mutated NOTHING in the guard's
  // diagnostic Set — strict legacy parity, the guard block never executed.
  expect(__runWorkflowNamesSeenSize()).toBe(seenSizeBefore);
});

it('Codex #7 transparent match → WORKFLOW_SLUG present + matching name → the full status-row + output flow runs undisturbed', async () => {
  // setup: the normal match path with WORKFLOW_SLUG set. This proves the
  // guard's match branch is transparent to the invoke/one-shot flow that
  // Phase-2's child-wait / cancellation depend on — the body runs, the
  // run-row CREATE is issued, and the durable output PUT lands, all in order.
  const wf = SolidActions.registerWorkflow(
    async (input: { n: number }) => ({ doubled: input.n * 2, ok: true }),
    { name: 'transparent-match-wf' },
  );

  // action
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    mockEnv({ WORKFLOW_SLUG: 'transparent-match-wf', WORKFLOW_INPUT: JSON.stringify({ n: 9 }) }),
  );

  // assert: full flow undisturbed by the guard — exit 0, run-row CREATE issued
  // BEFORE the output PUT, output PUT carries the SUCCESS result, run row
  // reports completed.
  expect(code).toBe(0);
  const createIdx = srv.lastRunStatusCreate();
  const outputPut = srv.lastOutputPut();
  expect(createIdx).toBeTruthy();
  expect(outputPut).toBeTruthy();
  // Ordering: the run-row CREATE precedes the durable output PUT.
  expect(createIdx!.index).toBeLessThan(outputPut!.index);
  expect(outputPut!.workflowID).toBe(RUN_ID);
  expect(outputPut!.body.status).toBe('SUCCESS');
  expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual({ doubled: 18, ok: true });
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
});

describe('__normalizeSlug — mirrors runner configSync.ts:191-193 slugify', () => {
  it('is a no-op for already-kebab names', () => {
    expect(__normalizeSlug('child-task')).toBe('child-task');
    expect(__normalizeSlug('multistep-parent')).toBe('multistep-parent');
  });

  it('lower-cases, collapses non-alphanumeric runs to a single dash, and trims edge dashes', () => {
    expect(__normalizeSlug('Child Task')).toBe('child-task');
    expect(__normalizeSlug('My__Workflow!!')).toBe('my-workflow');
    expect(__normalizeSlug('  Leading_Trailing  ')).toBe('leading-trailing');
    expect(__normalizeSlug('CamelCase')).toBe('camelcase');
  });
});

describe('__shouldFailLoudOnExit — pure decision for the process.on(exit) handler', () => {
  it('fires ONLY for a true misconfig: non-empty slug, nothing matched, at least one skipped', () => {
    expect(__shouldFailLoudOnExit('parent-child', false, true)).toBe(true);
  });

  it('stays silent when a run() matched (legitimate imported-child no-op case)', () => {
    // Parent process: run(childTask) skipped + run(parentChild) matched.
    expect(__shouldFailLoudOnExit('parent-child', true, true)).toBe(false);
    // Entrypoint child process: only run(childTask), which matched.
    expect(__shouldFailLoudOnExit('child-task', true, false)).toBe(false);
  });

  it('stays silent when WORKFLOW_SLUG is absent or empty (legacy/mock/local)', () => {
    expect(__shouldFailLoudOnExit(undefined, false, true)).toBe(false);
    expect(__shouldFailLoudOnExit('', false, true)).toBe(false);
  });

  it('stays silent when nothing was skipped (normal single-workflow run, no imports)', () => {
    expect(__shouldFailLoudOnExit('child-task', false, false)).toBe(false);
  });
});

describe('__failLoudExitCode — Defect C: never clobber an existing non-zero exit code', () => {
  it('returns 1 when the current exit code is unset (undefined) — the handler owns the failure signal', () => {
    expect(__failLoudExitCode(undefined)).toBe(1);
  });

  it('returns 1 when the current exit code is null (treated as unset)', () => {
    expect(__failLoudExitCode(null)).toBe(1);
  });

  it('returns 1 when the current exit code is 0 (success — safe to overwrite with the misconfig signal)', () => {
    expect(__failLoudExitCode(0)).toBe(1);
  });

  it("returns 1 when the current exit code is the string '0' (success, safe to overwrite)", () => {
    expect(__failLoudExitCode('0')).toBe(1);
  });

  it('returns undefined (leaves the code untouched) when a prior non-zero numeric code is already set — does NOT downgrade it', () => {
    expect(__failLoudExitCode(2)).toBeUndefined();
    expect(__failLoudExitCode(1)).toBeUndefined();
    expect(__failLoudExitCode(137)).toBeUndefined();
  });

  it('returns undefined when a prior non-zero STRING code is already set (Node coerces process.exitCode strings)', () => {
    expect(__failLoudExitCode('3')).toBeUndefined();
  });
});
