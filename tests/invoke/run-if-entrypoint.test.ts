/**
 * Codex Option 1A — entrypoint-identity dispatch guard on the one-shot path.
 *
 * Deployed workflow modules call `SolidActions.runIfEntrypoint(wf,
 * import.meta.url)` at top level. A parent that `import`s a child whose own
 * module has a top-level `runIfEntrypoint(childTask, import.meta.url)` would,
 * WITHOUT this guard, run the CHILD body against the PARENT's input (Node fully
 * evaluates the imported module — including its top-level call — before the
 * importer's body). The guard compares the CALLER MODULE's resolved path
 * against `process.argv[1]` (the file the runner invoked: `node
 * dist/<file>.js`) and makes the imported module's top-level call an inert
 * no-op, while a true entrypoint/codemod misconfig (the dispatched one-shot
 * module was skipped as non-entrypoint and NOTHING ran) trips a loud non-zero
 * exit instead of a silent never-runs hang.
 *
 * This replaces the retired name==WORKFLOW_SLUG match guard, which regressed
 * the alias pattern (1 source file deployed under N solidactions.yaml ids:
 * registered name `simple-steps` ≠ deployed slug `webhook-test` → the real
 * entrypoint was silently no-opped). File identity has NO name dependency.
 *
 * This suite proves:
 *  1. entrypoint   → runIfEntrypoint(wf, argv1Url) invokes the body (output PUT
 *                    observed on the mock, full one-shot flow).
 *  2. non-entrypoint→ runIfEntrypoint(wf, otherUrl) is an inert no-op (no
 *                    invoke, no status row, no process.exit, promise RESOLVES);
 *                    AND a SUBSEQUENT runIfEntrypoint(other, argv1Url) DOES
 *                    invoke — the imported-child-then-real-entrypoint sequence
 *                    works in one process.
 *  3. descriptor   → a `defineWorkflow({ run })` descriptor (NO name) via
 *                    runIfEntrypoint at the entrypoint STILL invokes — no name
 *                    dependency anywhere (this is the alias-safe property).
 *  4. fail-loud    → the pure __shouldFailLoudOnExit decision is exhaustively
 *                    tested (the process.on('exit') handler is wired to it),
 *                    and __failLoudExitCode never clobbers an existing non-zero
 *                    exit code.
 *  5. isEntrypointModule → the sync path-identity primitive: file: URL vs path,
 *                    resolution, and safe `false` on missing argv[1].
 *
 * Mock wiring mirrors run-statusrow.test.ts / run-compat.test.ts. `argv[1]` and
 * the `file:` callerUrls are synthesized by the test — no real FS is touched.
 */
/* eslint-disable @typescript-eslint/require-await --
 * The workflow fixtures are intentionally `async` (matching the one-shot run()
 * contract) even when their bodies have no await — that is the shape under
 * test, not a mistake. */
import { pathToFileURL } from 'node:url';
import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import {
  __shouldFailLoudOnExit,
  __failLoudExitCode,
  __entrypointGuardFlags,
  isEntrypointModule,
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

/**
 * A synthetic absolute path that stands in for the runner's
 * `node dist/<file>.js` argv[1]. Never touched on disk — isEntrypointModule is
 * pure path arithmetic (path.resolve + string compare), no FS access.
 */
const ARGV1_PATH = '/srv/deploy/dist/simple-steps.js';
const ARGV1_URL = pathToFileURL(ARGV1_PATH).href;
/** A DIFFERENT module — an imported child whose top-level call must no-op. */
const CHILD_URL = pathToFileURL('/srv/deploy/dist/child-task.js').href;

beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;

  // Pre-seed the run row exactly as run-statusrow.test.ts does. In a real
  // deployment the trigger-dispatch path creates the row before the one-shot
  // process starts; this keeps the entrypoint/non-entrypoint cases focused on
  // whether the body ran (output PUT) vs. the guard short-circuiting before any
  // write.
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

/**
 * Run `fn` with `process.argv[1]` overridden to ARGV1_PATH, restoring it after.
 * The runner invokes `node dist/<file>.js`, so argv[1] is the built entrypoint
 * file's absolute path; we synthesize it deterministically.
 */
async function withArgv1<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.argv[1];
  process.argv[1] = ARGV1_PATH;
  try {
    return await fn();
  } finally {
    process.argv[1] = prior;
  }
}

it('entrypoint → callerUrl === argv[1] → runIfEntrypoint(wf) invokes the body and PUTs the output (full one-shot flow)', async () => {
  // setup: a single-source-file workflow registered under ONE name but
  // deployed (its argv[1]) under a DIFFERENT slug — the alias pattern the old
  // name==WORKFLOW_SLUG guard regressed. File identity ignores the name.
  const wf = SolidActions.registerWorkflow(async (input: { n: number }) => input.n * 2, {
    name: 'simple-steps',
  });

  // action: callerUrl is the entrypoint file URL (=== argv[1]).
  const code = await withArgv1(() =>
    expectProcessExit(
      () => SolidActions.runIfEntrypoint(wf, ARGV1_URL),
      // WORKFLOW_SLUG deliberately DIFFERS from the registered name — proves
      // the guard no longer matches on name (alias-safe).
      mockEnv({ WORKFLOW_SLUG: 'webhook-test', WORKFLOW_INPUT: JSON.stringify({ n: 21 }) }),
    ),
  );

  // assert: the body ran — exit 0, the durable output PUT happened with the
  // SolidActionsJSON-serialized result, the run row reflects it, and the
  // run-row CREATE preceded the output PUT (full flow undisturbed).
  expect(code).toBe(0);
  const createIdx = srv.lastRunStatusCreate();
  const outputPut = srv.lastOutputPut();
  expect(createIdx).toBeTruthy();
  expect(outputPut).toBeTruthy();
  expect(createIdx!.index).toBeLessThan(outputPut!.index);
  expect(outputPut!.workflowID).toBe(RUN_ID);
  expect(outputPut!.body.status).toBe('SUCCESS');
  expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(42);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');
});

it('non-entrypoint → runIfEntrypoint(child, otherUrl) is an inert no-op (no invoke, no status row, no process.exit, promise RESOLVES); a subsequent entrypoint runIfEntrypoint still invokes', async () => {
  // setup: imported-child shape. The dispatched process is the PARENT
  // (argv[1] = ARGV1_PATH). The imported child module's top-level call passes
  // CHILD_URL (≠ argv[1]) and must no-op. Then the parent's OWN top-level call
  // passes ARGV1_URL (=== argv[1]) and must run.
  const childTask = SolidActions.registerWorkflow(
    async (_input: unknown) => 'child-ran',
    { name: 'child-task' },
  );
  const parent = SolidActions.registerWorkflow(
    async (input: { n: number }) => input.n + 100,
    { name: 'parent-child' },
  );

  const g = globalThis as Record<string, unknown>;
  const priorArmed = g.__processExitArmed;
  const priorRunId = process.env.SOLIDACTIONS_RUN_ID;
  const priorInput = process.env.WORKFLOW_INPUT;
  const priorUrl = process.env.SOLIDACTIONS_API_URL;
  const priorKey = process.env.SOLIDACTIONS_API_KEY;
  const priorArgv1 = process.argv[1];
  g.__processExitArmed = true;
  process.argv[1] = ARGV1_PATH;
  process.env.SOLIDACTIONS_RUN_ID = RUN_ID;
  process.env.WORKFLOW_INPUT = JSON.stringify({ n: 5 });
  process.env.SOLIDACTIONS_API_URL = srv.baseUrl;
  process.env.SOLIDACTIONS_API_KEY = 'test-api-key';

  try {
    // action 1: the imported child's top-level call — callerUrl ≠ argv[1].
    // Must NOT throw, NOT call process.exit, and RESOLVE cleanly.
    let resolved = false;
    await SolidActions.runIfEntrypoint(childTask, CHILD_URL).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);

    // No invoke happened: no output/error PUT, no workflow-complete POST, no
    // status-row create attempted by the skipped call.
    expect(srv.lastOutputPut()).toBeUndefined();
    expect(srv.lastErrorPut()).toBeUndefined();
    expect(srv.lastWorkflowCompleteIndex()).toBeUndefined();
    expect(srv.lastRunStatusCreate()).toBeUndefined();

    // The guard recorded a skip and (so far) no executed entrypoint run.
    expect(__entrypointGuardFlags().skipped).toBe(true);

    // action 2: the entrypoint's OWN top-level call (same process) — callerUrl
    // === argv[1]. DOES invoke (proves import-then-entrypoint sequence).
    await expect(SolidActions.runIfEntrypoint(parent, ARGV1_URL)).rejects.toMatchObject({
      name: 'ProcessExitSignal',
      code: 0,
    });

    // assert: the parent body ran — output PUT present with 5 + 100 = 105.
    const outputPut = srv.lastOutputPut();
    expect(outputPut).toBeTruthy();
    expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toEqual(105);
    expect(srv.lastWorkflowComplete()!.status).toBe('completed');
    expect(__entrypointGuardFlags().executed).toBe(true);
  } finally {
    g.__processExitArmed = priorArmed;
    process.argv[1] = priorArgv1;
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    };
    restore('SOLIDACTIONS_RUN_ID', priorRunId);
    restore('WORKFLOW_INPUT', priorInput);
    restore('SOLIDACTIONS_API_URL', priorUrl);
    restore('SOLIDACTIONS_API_KEY', priorKey);
  }
});

it('descriptor → a defineWorkflow({ run }) descriptor (NO name) via runIfEntrypoint at the entrypoint STILL invokes (no name dependency — alias-safe)', async () => {
  // setup: a `defineWorkflow({ run })` descriptor carries NO registration name
  // and no function `.name`. Under the RETIRED name==slug guard this was the
  // catastrophic over-block (wfName '' → forced no-op → hang). Entrypoint
  // identity has no name dependency: file === argv[1] → it runs.
  let bodyRan = false;
  const wf = defineWorkflow<{ n: number }, number>({
    run: async (ctx) => {
      bodyRan = true;
      return ctx.input.n * 3;
    },
  });

  // action: callerUrl === argv[1]; WORKFLOW_SLUG is a definitely-non-matching
  // slug (irrelevant now — the guard ignores it).
  const code = await withArgv1(() =>
    expectProcessExit(
      () => SolidActions.runIfEntrypoint(wf, ARGV1_URL, { input: { n: 7 } }),
      mockEnv({ WORKFLOW_SLUG: 'some-deployed-slug', WORKFLOW_INPUT: JSON.stringify({ n: 7 }) }),
    ),
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

describe('isEntrypointModule — synchronous path-identity primitive', () => {
  const priorArgv1 = process.argv[1];
  afterEach(() => {
    process.argv[1] = priorArgv1;
  });

  it('returns true when a file: URL resolves to argv[1]', () => {
    process.argv[1] = ARGV1_PATH;
    expect(isEntrypointModule(ARGV1_URL)).toBe(true);
  });

  it('returns true when a bare path equals argv[1]', () => {
    process.argv[1] = ARGV1_PATH;
    expect(isEntrypointModule(ARGV1_PATH)).toBe(true);
  });

  it('normalizes both sides via path.resolve before comparing', () => {
    process.argv[1] = '/srv/deploy/dist/../dist/simple-steps.js';
    expect(isEntrypointModule(ARGV1_URL)).toBe(true);
  });

  it('returns false for a different module (an imported child)', () => {
    process.argv[1] = ARGV1_PATH;
    expect(isEntrypointModule(CHILD_URL)).toBe(false);
  });

  it('returns false (safe) when argv[1] is missing/empty', () => {
    // @ts-expect-error — exercising the missing-argv[1] guard path.
    process.argv[1] = undefined;
    expect(isEntrypointModule(ARGV1_URL)).toBe(false);
    process.argv[1] = '';
    expect(isEntrypointModule(ARGV1_URL)).toBe(false);
  });

  it('returns false (safe) for an empty or malformed callerUrl', () => {
    process.argv[1] = ARGV1_PATH;
    expect(isEntrypointModule('')).toBe(false);
    expect(isEntrypointModule('file://')).toBe(false);
  });
});

describe('__shouldFailLoudOnExit — pure decision for the process.on(exit) handler', () => {
  it('fires ONLY for a true misconfig: one-shot present, nothing executed, at least one skipped', () => {
    expect(__shouldFailLoudOnExit(true, false, true)).toBe(true);
  });

  it('stays silent when an entrypoint run executed (legitimate imported-child no-op case)', () => {
    // Parent process: child runIfEntrypoint skipped + parent runIfEntrypoint executed.
    expect(__shouldFailLoudOnExit(true, true, true)).toBe(false);
    // Standalone/alias entrypoint: only its own call, which executed.
    expect(__shouldFailLoudOnExit(true, true, false)).toBe(false);
  });

  it('stays silent when this process is NOT a dispatched one-shot run (legacy/mock/local/direct run())', () => {
    expect(__shouldFailLoudOnExit(false, false, true)).toBe(false);
  });

  it('stays silent when nothing was skipped (normal single-workflow entrypoint, no imports)', () => {
    expect(__shouldFailLoudOnExit(true, false, false)).toBe(false);
  });

  it('exhaustive truth table — exactly the (one-shot ∧ ¬executed ∧ skipped) cell is true', () => {
    for (const oneShot of [false, true]) {
      for (const executed of [false, true]) {
        for (const skipped of [false, true]) {
          const expected = oneShot && !executed && skipped;
          expect(__shouldFailLoudOnExit(oneShot, executed, skipped)).toBe(expected);
        }
      }
    }
  });
});

describe('__failLoudExitCode — never clobber an existing non-zero exit code', () => {
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
