/**
 * T3 of the SolidActions SDK launcher rework —
 * paired-parity tests for the SDK-owned launcher.
 *
 * The launcher (`src/launcher.ts`) is the fixed process entrypoint the
 * runner will execute in launcher mode (T4 wires it). It dynamic-imports
 * a (post-codemod, pure) workflow module, selects the target workflow
 * from the registry (T1), and invokes it via `SolidActions.run()` (T2)
 * — the SAME validated one-shot core direct `run(wf)` uses.
 *
 * The crucial test class is **paired parity**: for each workflow shape
 * (completed, throwing, suspend, cancelled, respond), drive the SAME
 * fixture through both paths against the SAME mock server and assert
 * the recorded request sequences are byte-equivalent (modulo each run's
 * unique runUuid in the path). If the launcher ever drifts from
 * `run()` — e.g. an extra row create, a different terminal write, a
 * skipped webhook PUT — these tests fail.
 *
 * Selection cases prove the algorithm:
 *   - exactly one registered → use it (alias case runs regardless of
 *     WORKFLOW_ID).
 *   - multi-registration → look up by WORKFLOW_ID.
 *   - zero registered OR unknown WORKFLOW_ID → synthetic throwing
 *     descriptor flows through `SolidActions.run()` → real status row
 *     create + error PUT recorded (NOT a raw `console.error`+exit).
 *
 * Misconfig cases prove the launcher fails LOUDLY before touching the
 * mock when env contract is broken — exit 2 (distinct from the 0/1
 * exit codes `oneShotRuntimeAdapter` emits).
 */
/* eslint-disable @typescript-eslint/require-await -- async workflow contract */
import * as nodePath from 'node:path';
import * as fs from 'node:fs'; // used by the import-surface guard test

import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { __clearRegistry, __getRegisteredWorkflow } from '../../src/invoke/registry';
import { MockHttpServer } from '../../src/testing/mock_server';
import { SolidActionsJSON } from '../../src/serialization';
import {
  main as launcherMain,
  selectWorkflow,
  makeSelectionFailureDescriptor,
  LAUNCHER_MISCONFIG_EXIT_CODE,
} from '../../src/launcher';
import {
  __getStartedOneShotRun,
  __resetStartedOneShotRunForTests,
  __entrypointGuardFlags,
  __shouldFailLoudOnExit,
} from '../../src/solidactions';

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

/** Absolute path to a fixture file (ts-jest resolves .ts on dynamic import). */
function fixturePath(basename: string): string {
  return nodePath.resolve(__dirname, 'fixtures', basename);
}

/** Pre-seed the run row + ops slot, mirroring run-statusrow / run-compat. */
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

/**
 * Snapshot the relevant portion of the mock requestLog for parity comparison,
 * normalizing each entry's path by replacing the run-specific UUID with the
 * literal `<RUN_ID>` so two runs with different UUIDs compare equal.
 *
 * Why this is sound: every workflow-scoped request travels under
 * `/runs/status/<runUuid>/...`; replacing the UUID is the ONLY noise between
 * two independent runs of the SAME workflow against the SAME mock. Method,
 * sub-path, and JSON body are compared verbatim. (workflowUUID inside bodies
 * is also normalized for the same reason.)
 *
 * NOTE on the run-row create body: that POST embeds `createdAt = Date.now()`
 * and `ownerXid = randomUUID()`. Both are intentionally per-run and would
 * differ between direct and launcher paths even with identical semantics —
 * the launcher executes a microsecond later than the direct path. We strip
 * those two timestamp/randomness fields from the create body for comparison
 * purposes only; everything else (workflowName, applicationID, status, etc.)
 * is compared verbatim.
 */
type NormalizedEntry = {
  method: string;
  path: string;
  body: unknown;
};

function normalizeLog(runId: string): NormalizedEntry[] {
  const out: NormalizedEntry[] = [];
  const runIdRe = new RegExp(runId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
  for (const entry of srv.requestLog) {
    const path = entry.path.replace(runIdRe, '<RUN_ID>');
    let body: unknown = entry.body;
    if (body && typeof body === 'object') {
      // Clone + scrub per-run fields.
      const cloned = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
      if (typeof cloned.workflowUUID === 'string') {
        cloned.workflowUUID = cloned.workflowUUID.replace(runIdRe, '<RUN_ID>');
      }
      // Run-row create body: strip per-run-noise fields.
      if (path === '/runs/status' && entry.method === 'POST') {
        delete cloned.createdAt;
        delete cloned.ownerXid;
      }
      // Sleep-schedule body: `wakeupTime` is `Date.now() + duration` — the
      // duration is deterministic but the base time shifts microseconds
      // between the two phases. Same legitimate parity case as createdAt.
      if (/\/sleep$/.test(path) && entry.method === 'POST') {
        delete cloned.wakeupTime;
      }
      // Task 3.1 vars-snapshot body: contains the WHOLE adapter-supplied
      // ctx.vars (= the entire process.env minus reserved keys). The
      // launcher path injects WORKFLOW_ENTRY_FILE / WORKFLOW_ID into
      // process.env that the direct path does not, so the captured snapshot
      // legitimately differs between paths. The semantically meaningful
      // assertion is that BOTH paths POST `/vars-snapshot` exactly once with
      // a `vars` body — not that the body is byte-identical. Strip the
      // body's `vars` field for comparison purposes; the path + method are
      // still compared verbatim.
      if (/\/vars-snapshot$/.test(path) && entry.method === 'POST') {
        delete cloned.vars;
      }
      // Operation record bodies: startedAtEpochMs / startTimeEpochMs /
      // completedAtEpochMs / endTimeEpochMs are wall-clock timestamps.
      if (/\/operations$/.test(path) && entry.method === 'POST') {
        delete cloned.startedAtEpochMs;
        delete cloned.startTimeEpochMs;
        delete cloned.completedAtEpochMs;
        delete cloned.endTimeEpochMs;
      }
      // Error PUT body and workflow-complete POST body: the serialized error
      // is `SolidActionsJSON.stringify(serializeError(err))` (legacy shape).
      // The stack trace captured by serializeError is intrinsically
      // call-site-dependent — the launcher path includes a `main (.../launcher.ts:...)`
      // frame that the direct path does not, so a byte-for-byte comparison of
      // the raw stack would always fail. Round-trip the JSON envelope,
      // strip the stack, and re-encode. The error `name` + `message` are
      // preserved verbatim and compared — that is the byte-faithful part of
      // the error contract.
      if (typeof cloned.error === 'string') {
        try {
          const parsed = JSON.parse(cloned.error) as { json?: { stack?: string } };
          if (parsed?.json && typeof parsed.json === 'object') {
            parsed.json.stack = '<STRIPPED>';
            cloned.error = JSON.stringify(parsed);
          }
        } catch {
          // Bare-message error (e.g. from reportWorkflowComplete) — leave as is.
        }
      }
      body = cloned;
    }
    out.push({ method: entry.method, path, body });
  }
  return out;
}

/**
 * INTENTIONAL test-suite invariant: the SDK's workflow registry persists
 * ACROSS tests in this file. Jest's module loader caches dynamic-imported
 * `.ts` fixtures by absolute path, and clearing `require.cache` does NOT
 * undo Jest's internal module registry — so a second `import(fixturePath)`
 * is always a cache hit and the fixture's `defineWorkflow()` call never
 * re-runs. We work around this constraint by ensuring each test uses a
 * UNIQUE fixture-file path / registered name (no name collisions), so the
 * accumulating registry is harmless.
 *
 * Tests that REQUIRE a pristine registry (the "zero registered" selection-
 * failure case and the `selectWorkflow` unit case) call `__clearRegistry()`
 * explicitly at the top of their body. Once those tests run, the cleared
 * registry stays empty until the next test re-imports a fixture — and
 * because each subsequent test imports a fixture whose body still holds
 * its registration call as a top-level `const = defineWorkflow(...)`, the
 * "after clear" pristine state is correctly transient.
 *
 * Critically the "zero registered" test imports `launcher-empty.ts` (which
 * exports no workflow) — so even after the clear, the launcher sees an
 * empty registry. That is what we want.
 */
beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;
  __resetStartedOneShotRunForTests();
});

// =============================================================================
// PAIRED PARITY — direct SolidActions.run(wf) vs launcher main()
// =============================================================================

describe('paired parity: direct run() vs launcher selection', () => {
  /** Run both paths against the SAME mock + fixture; return normalized logs. */
  async function runBothPaths(
    fixtureBasename: string,
    workflowName: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{ direct: NormalizedEntry[]; launcher: NormalizedEntry[]; directExit: number; launcherExit: number }> {
    // --- direct path ---
    const DIRECT_RUN_ID = '00000000-0000-4000-8000-000000000d01';
    seedRun(DIRECT_RUN_ID);
    // Import the fixture so the workflow registers; capture the descriptor.
    await import(fixturePath(fixtureBasename));
    const wf = __getRegisteredWorkflow(workflowName);
    if (!wf) {
      throw new Error(`Test setup: fixture ${fixtureBasename} did not register '${workflowName}'`);
    }
    const directExit = await expectProcessExit(() => SolidActions.run(wf), mockEnv(DIRECT_RUN_ID, extraEnv));
    const direct = normalizeLog(DIRECT_RUN_ID);

    // --- reset for launcher path (fresh mock state only) ---
    // CRUCIAL: do NOT clear the registry between phases. Jest caches
    // dynamic-imported `.ts` fixtures and `require.cache` deletion does NOT
    // bust Jest's internal cache — the launcher's `import(fixturePath)` is
    // a cache HIT and re-running `defineWorkflow` never happens. The first
    // phase's import already populated the registry; registry.ts:38-49
    // makes re-registration of the SAME descriptor idempotent. Leaving the
    // registry populated is therefore both correct AND necessary.
    srv.store.clear();
    srv.requestLog.length = 0;
    // The direct-path phase above just called SolidActions.run(wf), which
    // records __startedOneShotRun (issue solidactions-app#414's guard state).
    // In production each one-shot process runs exactly once; this helper
    // simulates TWO INDEPENDENT process invocations sharing one Jest process,
    // so reset the record here — otherwise the launcher phase's guard would
    // (correctly, given its own logic) mistake the direct phase's run for a
    // self-invoke of THIS phase's module and defer instead of running.
    __resetStartedOneShotRunForTests();

    const LAUNCHER_RUN_ID = '00000000-0000-4000-8000-000000000d02';
    seedRun(LAUNCHER_RUN_ID);
    const launcherExit = await expectProcessExit(
      () => launcherMain(),
      mockEnv(LAUNCHER_RUN_ID, {
        ...extraEnv,
        WORKFLOW_ENTRY_FILE: fixturePath(fixtureBasename),
        // For the parity tests, use the workflow's real registered name as
        // WORKFLOW_ID. The single-registration alias case is exercised in
        // the dedicated selection test below.
        WORKFLOW_ID: workflowName,
      }),
    );
    const launcher = normalizeLog(LAUNCHER_RUN_ID);

    return { direct, launcher, directExit, launcherExit };
  }

  it('Parity 1 — happy path: completed workflow has byte-identical request sequences', async () => {
    const { direct, launcher, directExit, launcherExit } = await runBothPaths(
      'launcher-completed.ts',
      'launcher-completed',
      { WORKFLOW_INPUT: JSON.stringify({ n: 21 }) },
    );
    expect(directExit).toBe(0);
    expect(launcherExit).toBe(0);
    expect(launcher).toEqual(direct);
    // Sanity: the recorded log includes the row create + output PUT + complete POST.
    const methods = direct.map((e) => `${e.method} ${e.path}`);
    expect(methods).toContain('POST /runs/status');
    expect(methods).toContain('PUT /runs/status/<RUN_ID>/output');
    expect(methods).toContain('POST /runs/status/<RUN_ID>/workflow-complete');
  });

  it('Parity 2 — error path: throwing workflow records identical error PUT + workflow-complete bodies', async () => {
    const { direct, launcher, directExit, launcherExit } = await runBothPaths(
      'launcher-throwing.ts',
      'launcher-throwing',
      { WORKFLOW_INPUT: '{}' },
    );
    expect(directExit).toBe(1);
    expect(launcherExit).toBe(1);
    expect(launcher).toEqual(direct);
    const methods = direct.map((e) => `${e.method} ${e.path}`);
    expect(methods).toContain('PUT /runs/status/<RUN_ID>/error');
    expect(methods).toContain('POST /runs/status/<RUN_ID>/workflow-complete');
  });

  it('Parity 3 — suspend: durable sleep produces identical step + sleep-schedule + NO terminal write', async () => {
    const { direct, launcher, directExit, launcherExit } = await runBothPaths('launcher-sleep.ts', 'launcher-sleep', {
      WORKFLOW_INPUT: '{}',
    });
    expect(directExit).toBe(0);
    expect(launcherExit).toBe(0);
    expect(launcher).toEqual(direct);
    const methods = direct.map((e) => `${e.method} ${e.path}`);
    // Sleep schedule POST present, terminal output/error PUT + workflow-complete absent.
    expect(methods).toContain('POST /runs/status/<RUN_ID>/sleep');
    expect(methods).not.toContain('PUT /runs/status/<RUN_ID>/output');
    expect(methods).not.toContain('PUT /runs/status/<RUN_ID>/error');
    expect(methods).not.toContain('POST /runs/status/<RUN_ID>/workflow-complete');
  });

  it('Parity 4 — cancel: identical cancelled-terminal write and exit code', async () => {
    const { direct, launcher, directExit, launcherExit } = await runBothPaths(
      'launcher-cancelled.ts',
      'launcher-cancelled',
      { WORKFLOW_INPUT: '{}' },
    );
    // Legacy parity: cancelled maps to exit 1 (see runtime-adapter.ts).
    expect(directExit).toBe(1);
    expect(launcherExit).toBe(1);
    expect(launcher).toEqual(direct);
  });

  it('Parity 5 — respond(): webhook-output PUT precedes workflow-complete in both paths', async () => {
    const { direct, launcher, directExit, launcherExit } = await runBothPaths(
      'launcher-respond.ts',
      'launcher-respond',
      { WORKFLOW_INPUT: '{}' },
    );
    expect(directExit).toBe(0);
    expect(launcherExit).toBe(0);
    expect(launcher).toEqual(direct);

    const webhookIdx = direct.findIndex((e) => e.method === 'PUT' && e.path === '/runs/status/<RUN_ID>/webhook-output');
    const completeIdx = direct.findIndex(
      (e) => e.method === 'POST' && e.path === '/runs/status/<RUN_ID>/workflow-complete',
    );
    expect(webhookIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThanOrEqual(0);
    expect(webhookIdx).toBeLessThan(completeIdx);
  });
});

// =============================================================================
// SELECTION
// =============================================================================

describe('launcher selection algorithm', () => {
  it('exactly one registered → use it (alias case): runs the sole workflow even when WORKFLOW_ID differs from its registered name', async () => {
    // Pin registry to EXACTLY one workflow. Then point the launcher at an
    // empty fixture (no registrations) so its `await import()` is a no-op
    // and leaves our pinned single-registration intact. WORKFLOW_ID is
    // deliberately DIFFERENT from the registered name — selectWorkflow's
    // single-registration branch must run it anyway.
    __clearRegistry();
    defineWorkflow({
      name: 'launcher-alias-real-name',
      run: async () => 'alias-output',
    });

    const RUN_ID = '00000000-0000-4000-8000-000000000d10';
    seedRun(RUN_ID);

    const exit = await expectProcessExit(
      () => launcherMain(),
      mockEnv(RUN_ID, {
        // Point at the empty fixture so the dynamic-import does not
        // re-register and collide with the programmatic registration above.
        // (The launcher-alias.ts fixture registers the same name; importing
        // both would throw WorkflowAlreadyRegisteredError. The launcher's
        // job is only to import the entry file — it does NOT require that
        // file to register anything itself; the alias case is about exactly
        // one registration being visible in the registry by the time
        // selection runs, irrespective of HOW it got there.)
        WORKFLOW_ENTRY_FILE: fixturePath('launcher-empty.ts'),
        // Deliberately DIFFERENT from the registered name.
        WORKFLOW_ID: 'some-other-deploy-slug',
        WORKFLOW_INPUT: '{}',
      }),
    );
    expect(exit).toBe(0);
    // The output PUT body proves the alias workflow's `run` returned its
    // value. recordWorkflowOutput PUTs the SolidActionsJSON.stringify'd
    // form (legacy shape — see run-statusrow.test.ts), so round-trip via
    // SolidActionsJSON.
    const outputPut = srv.lastOutputPut();
    expect(outputPut).toBeTruthy();
    expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toBe('alias-output');
  });

  it('multi-workflow module + matching WORKFLOW_ID → runs the matched workflow', async () => {
    // Pin registry to EXACTLY these two workflows. Point the launcher at
    // an empty entry file so its import doesn't re-register (see the alias
    // test for the rationale).
    __clearRegistry();
    defineWorkflow({ name: 'launcher-multi-first', run: async () => 'first-output' });
    defineWorkflow({ name: 'launcher-multi-second', run: async () => 'second-output' });

    const RUN_ID = '00000000-0000-4000-8000-000000000d11';
    seedRun(RUN_ID);

    const exit = await expectProcessExit(
      () => launcherMain(),
      mockEnv(RUN_ID, {
        WORKFLOW_ENTRY_FILE: fixturePath('launcher-empty.ts'),
        WORKFLOW_ID: 'launcher-multi-second',
        WORKFLOW_INPUT: '{}',
      }),
    );
    expect(exit).toBe(0);
    const outputPut = srv.lastOutputPut();
    expect(outputPut).toBeTruthy();
    expect(SolidActionsJSON.parse(outputPut!.body.output as string)).toBe('second-output');
  });

  it('zero registered workflows → synthetic-failure descriptor flows through run() → real error PUT recorded (not a raw process.exit)', async () => {
    // This case needs a PRISTINE registry: the launcher imports launcher-empty.ts
    // (which registers nothing), so selection must see zero workflows. Prior
    // tests in this file may have left fixture-registered workflows in the
    // process-global registry; clear here so this test's assertion is genuine.
    __clearRegistry();
    const RUN_ID = '00000000-0000-4000-8000-000000000d12';
    seedRun(RUN_ID);

    const exit = await expectProcessExit(
      () => launcherMain(),
      mockEnv(RUN_ID, {
        WORKFLOW_ENTRY_FILE: fixturePath('launcher-empty.ts'),
        WORKFLOW_ID: 'irrelevant',
        WORKFLOW_INPUT: '{}',
      }),
    );
    // Failed-workflow exit code (parity with any throwing run).
    expect(exit).toBe(1);
    // The mock recorded a REAL row create + error PUT (not skipped by a raw
    // console.error+process.exit). The error PUT body is the legacy serialized
    // shape (serialize-error + SolidActionsJSON.stringify) — round-trip
    // through SolidActionsJSON to read the error envelope.
    const errorPut = srv.lastErrorPut();
    expect(errorPut).toBeTruthy();
    const decoded = SolidActionsJSON.parse(errorPut!.body.error as string) as { message?: string };
    expect(decoded.message).toMatch(/no workflows registered/);
  });

  it('multi-workflow module + unknown WORKFLOW_ID → synthetic-failure descriptor flows through run() → error PUT lists candidates', async () => {
    // Pin the registry state programmatically (Jest module-cache invariance
    // makes file-based imports non-repeatable across tests; see file header).
    __clearRegistry();
    defineWorkflow({ name: 'launcher-multi-first', run: async () => 'first-output' });
    defineWorkflow({ name: 'launcher-multi-second', run: async () => 'second-output' });

    const RUN_ID = '00000000-0000-4000-8000-000000000d13';
    seedRun(RUN_ID);

    const exit = await expectProcessExit(
      () => launcherMain(),
      mockEnv(RUN_ID, {
        // Empty fixture entry file (see alias test rationale).
        WORKFLOW_ENTRY_FILE: fixturePath('launcher-empty.ts'),
        WORKFLOW_ID: 'not-a-known-name',
        WORKFLOW_INPUT: '{}',
      }),
    );
    expect(exit).toBe(1);
    const errorPut = srv.lastErrorPut();
    expect(errorPut).toBeTruthy();
    const decoded = SolidActionsJSON.parse(errorPut!.body.error as string) as { message?: string };
    expect(decoded.message).toMatch(/not-a-known-name/);
    expect(decoded.message).toMatch(/launcher-multi-first/);
    expect(decoded.message).toMatch(/launcher-multi-second/);
  });

  it('pure selectWorkflow() unit: enumerates registry and routes failures to a synthetic throwing descriptor (testable in isolation)', async () => {
    // This test asserts on the launcher's algorithm directly. Other tests
    // in the suite leave fixture-registered workflows in the registry on
    // purpose (Node module-cache invariance); clear here so the unit case
    // starts pristine.
    __clearRegistry();
    // Empty registry → no-registrations.
    const empty = selectWorkflow('any');
    expect(empty.reason).toBe('no-registrations');
    expect(empty.descriptor.name).toBe('__launcher_selection_failure__');
    await expect(empty.descriptor.run({} as never)).rejects.toThrow(/no workflows registered/);

    // Single registration → return it regardless of id.
    const w = defineWorkflow({ name: 'unit-single', run: async () => 'x' });
    const single = selectWorkflow('mismatched-id');
    expect(single.reason).toBe('single');
    expect(single.descriptor).toBe(w);

    // Multi → match by id.
    const w2 = defineWorkflow({ name: 'unit-two', run: async () => 'y' });
    const byId = selectWorkflow('unit-two');
    expect(byId.reason).toBe('by-id');
    expect(byId.descriptor).toBe(w2);

    // Multi + unknown id → unknown-id.
    const unknown = selectWorkflow('not-here');
    expect(unknown.reason).toBe('unknown-id');
    await expect(unknown.descriptor.run({} as never)).rejects.toThrow(/not-here/);
  });
});

// =============================================================================
// MISCONFIG (pre-run; no mock traffic)
// =============================================================================

describe('launcher misconfig (missing required env)', () => {
  it('missing WORKFLOW_ENTRY_FILE → exit 2; no mock requests sent', async () => {
    const exit = await expectProcessExit(() => launcherMain(), {
      SOLIDACTIONS_API_URL: srv.baseUrl,
      SOLIDACTIONS_API_KEY: 'test-api-key',
      WORKFLOW_ID: 'whatever',
    });
    expect(exit).toBe(LAUNCHER_MISCONFIG_EXIT_CODE);
    expect(LAUNCHER_MISCONFIG_EXIT_CODE).toBe(2);
    expect(srv.requestLog.length).toBe(0);
  });

  it('missing WORKFLOW_ID → exit 2; no mock requests sent', async () => {
    const exit = await expectProcessExit(() => launcherMain(), {
      SOLIDACTIONS_API_URL: srv.baseUrl,
      SOLIDACTIONS_API_KEY: 'test-api-key',
      WORKFLOW_ENTRY_FILE: fixturePath('launcher-completed.ts'),
    });
    expect(exit).toBe(LAUNCHER_MISCONFIG_EXIT_CODE);
    expect(srv.requestLog.length).toBe(0);
  });

  it('empty-string WORKFLOW_ENTRY_FILE counts as missing → exit 2', async () => {
    const exit = await expectProcessExit(() => launcherMain(), {
      SOLIDACTIONS_API_URL: srv.baseUrl,
      WORKFLOW_ENTRY_FILE: '',
      WORKFLOW_ID: 'whatever',
    });
    expect(exit).toBe(LAUNCHER_MISCONFIG_EXIT_CODE);
  });
});

// =============================================================================
// IMPORT-SURFACE GUARD — launcher must not pull in engine internals
// =============================================================================

describe('launcher import surface', () => {
  it('src/launcher.ts imports the SDK public API + registry accessors ONLY (no invoke engine internals)', () => {
    const launcherSrc = fs.readFileSync(nodePath.resolve(__dirname, '../../src/launcher.ts'), 'utf8');

    // The launcher MUST NOT import engine internals — those carry the
    // module-load cycle `run()` lazy-requires precisely to avoid.
    const forbidden = [
      "from './invoke/invoke'",
      'from "./invoke/invoke"',
      "from './invoke/invoke-system-database'",
      "from './invoke/context-adapter'",
      "from './invoke/runtime-adapter'",
      "from './invoke/runtime-scope'",
      "from './invoke/child-workflow'",
      "from './http_client'",
      "from './http_system_database'",
    ];
    for (const needle of forbidden) {
      expect(launcherSrc.includes(needle)).toBe(false);
    }
    // The launcher MUST import these (positive controls).
    expect(launcherSrc).toMatch(/from\s+['"]\.\/solidactions['"]/);
    expect(launcherSrc).toMatch(/from\s+['"]\.\/invoke\/define-workflow['"]/);
    expect(launcherSrc).toMatch(/from\s+['"]\.\/invoke\/registry['"]/);
  });
});

// =============================================================================
// makeSelectionFailureDescriptor — does NOT pollute the registry on construction
// =============================================================================

describe('makeSelectionFailureDescriptor', () => {
  it('returns a bare descriptor; does NOT register the synthetic name in the process-global registry', () => {
    __clearRegistry();
    const desc = makeSelectionFailureDescriptor('hello');
    expect(desc.name).toBe('__launcher_selection_failure__');
    // The registry stays empty — the synthetic name was NOT inserted.
    expect(__getRegisteredWorkflow('__launcher_selection_failure__')).toBeUndefined();
  });
});

// =============================================================================
// SELF-INVOKING MODULES (issue solidactions-app#414) — the launcher must never
// start a SECOND run when the imported module already self-invoked
// SolidActions.run() at top level (legacy pre-codemod style). A second,
// concurrent one-shot run would re-run the workflow body AND its
// oneShotContextAdapter would observe process.env AFTER the first run's
// var-manifest scrub — the root cause of the empty-ctx.vars bug.
// =============================================================================

describe('self-invoking modules (issue solidactions-app#414)', () => {
  /**
   * Capture `console.log`/`console.error` output for the duration of the
   * callback while still forwarding to the real methods (so Jest's own
   * console reporting is unaffected) — not a mock of any SDK behavior, just
   * an observation seam on real output.
   *
   * NOT implemented via `process.stdout.write`/`process.stderr.write`
   * interception: Jest's `CustomConsole` (installed as the test-environment
   * `console`) formats every `console.*` call — `log` AND `error` alike —
   * and writes ALL of it to `process.stdout` for its own test-output
   * grouping; `process.stderr.write` is never actually called, so a
   * stream-level interceptor cannot distinguish log-level (verified: a
   * standalone repro showed `console.error` output landing in the captured
   * "stdout" buffer, never the "stderr" one). Intercepting at the
   * `console.log`/`console.error` method level instead preserves the
   * distinction the fixtures and the launcher's warnings rely on.
   */
  function captureStreams(): { stop: () => { stdout: string; stderr: string } } {
    const realLog = console.log.bind(console);
    const realError = console.error.bind(console);
    let stdout = '';
    let stderr = '';
    console.log = (...args: unknown[]) => {
      stdout += args.map((a) => String(a)).join(' ') + '\n';
      realLog(...args);
    };
    console.error = (...args: unknown[]) => {
      stderr += args.map((a) => String(a)).join(' ') + '\n';
      realError(...args);
    };
    return {
      stop: () => {
        console.log = realLog;
        console.error = realError;
        return { stdout, stderr };
      },
    };
  }

  /**
   * A self-invoking fixture calls `void SolidActions.run(wf)` at module top
   * level — the promise is intentionally discarded (that IS the legacy shape
   * under test), so there is no handle the test can `await` directly, and
   * nothing ever consumes its rejection if `process.exit()` throws (jest's
   * own unhandled-rejection handling derails whatever test is currently
   * running when that happens — verified experimentally, not just theory).
   * Make `process.exit()` a harmless recording no-op instead of the shared
   * armed-throw interceptor for the scope of one drive call: the self-invoked
   * run's promise then RESOLVES normally (no throw, no unhandled rejection),
   * and polling `exitCodes` tells us when it (and the workflow body inside
   * it) has finished. This overrides the SAME built-in `process.exit` the
   * shared jest.setup.ts interceptor already overrides — not a mock/spy of
   * any SDK function, just a different swap of the same real global.
   */
  function stubProcessExitNoop(): { exitCodes: number[]; restore: () => void } {
    const prior = process.exit.bind(process);
    const exitCodes: number[] = [];
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
    }) as typeof process.exit;
    return {
      exitCodes,
      restore: () => {
        process.exit = prior;
      },
    };
  }

  /** Poll `predicate` on a real timer until it's true or `timeoutMs` elapses. */
  async function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('waitUntil: timed out waiting for condition');
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Drive the launcher against a self-invoking fixture: set env, capture
   * stdout/stderr, stub process.exit as a no-op, run `launcherMain()` (which
   * — once the guard under test exists — defers and returns WITHOUT calling
   * process.exit itself), then poll until the fixture's own unawaited
   * top-level `SolidActions.run()` call has reached ITS process.exit —
   * proof its workflow body (and everything before the exit) has run.
   */
  async function driveSelfInvokingLauncher(env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
    const priorEnv: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
      priorEnv[key] = process.env[key];
      process.env[key] = env[key];
    }

    const capture = captureStreams();
    const exitStub = stubProcessExitNoop();
    let captured: { stdout: string; stderr: string };
    try {
      await launcherMain();
      await waitUntil(() => exitStub.exitCodes.length >= 1);
    } finally {
      captured = capture.stop();
      exitStub.restore();
      for (const key of Object.keys(env)) {
        if (priorEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = priorEnv[key];
        }
      }
    }
    return captured;
  }

  it('defers to a legacy self-invoking module: body runs exactly once, launcher warns and does not run again', async () => {
    const RUN_ID = '00000000-0000-4000-8000-000000000e01';
    seedRun(RUN_ID);

    const { stdout, stderr } = await driveSelfInvokingLauncher(
      mockEnv(RUN_ID, {
        WORKFLOW_ENTRY_FILE: fixturePath('launcher-self-invoke-legacy.ts'),
        WORKFLOW_ID: 'legacy-self-invoked',
        WORKFLOW_INPUT: JSON.stringify({ probe: 'hello' }),
      }),
    );

    expect(stdout.match(/SELF_INVOKE_LEGACY_RAN/g)).toHaveLength(1);
    expect(stderr).toContain('solidactions-launch: legacy self-invoking module detected');
  });

  it('a self-invoking defineWorkflow module keeps populated ctx.vars (regression: empty-vars)', async () => {
    const RUN_ID = '00000000-0000-4000-8000-000000000e02';
    seedRun(RUN_ID);

    const { stdout } = await driveSelfInvokingLauncher(
      mockEnv(RUN_ID, {
        WORKFLOW_ENTRY_FILE: fixturePath('launcher-self-invoke-ctx.ts'),
        WORKFLOW_ID: 'ctx-self-invoked',
        WORKFLOW_INPUT: '{}',
        SOLIDACTIONS__VAR_KEYS: 'FOO',
        FOO: 'bar-secret',
      }),
    );

    expect(stdout.match(/SELF_INVOKE_CTX_VARS=/g)).toHaveLength(1);
    expect(stdout).toContain('SELF_INVOKE_CTX_VARS=["FOO"]');
  });

  it('multi-workflow module self-invoking a DIFFERENT workflow than WORKFLOW_ID: loud error, no second run', async () => {
    const RUN_ID = '00000000-0000-4000-8000-000000000e03';
    seedRun(RUN_ID);

    const { stdout, stderr } = await driveSelfInvokingLauncher(
      mockEnv(RUN_ID, {
        WORKFLOW_ENTRY_FILE: fixturePath('launcher-self-invoke-mismatch.ts'),
        WORKFLOW_ID: 'mismatch-beta',
        WORKFLOW_INPUT: '{}',
      }),
    );

    expect(stdout.match(/MISMATCH_ALPHA_RAN/g)).toHaveLength(1);
    expect(stdout).not.toContain('MISMATCH_BETA_RAN');
    expect(stderr).toMatch(/self-invoked workflow 'mismatch-alpha'.*'mismatch-beta'/s);
  });

  it('pure-descriptor module is unaffected: launcher runs it exactly once', async () => {
    // launcher-alias.ts is never imported by any other test in this file, so
    // this is its first (and only) import — no registry collision risk. It
    // registers ONE workflow and self-invokes nothing, so __getStartedOneShotRun()
    // is null right after import — the guard must see that and no-op, letting
    // the launcher's own (normal, non-deferring) SolidActions.run() call proceed.
    __clearRegistry();
    expect(__getStartedOneShotRun()).toBeNull();
    const RUN_ID = '00000000-0000-4000-8000-000000000e04';
    seedRun(RUN_ID);

    const exit = await expectProcessExit(
      () => launcherMain(),
      mockEnv(RUN_ID, {
        WORKFLOW_ENTRY_FILE: fixturePath('launcher-alias.ts'),
        WORKFLOW_ID: 'irrelevant-for-the-single-registration-alias-case',
        WORKFLOW_INPUT: '{}',
      }),
    );

    // The launcher's OWN SolidActions.run(descriptor) call — the normal
    // path — is what (correctly) sets the flag; proof of single execution is
    // the output PUT count, not the flag's post-hoc value.
    expect(exit).toBe(0);
    const outputPuts = srv.requestLog.filter((e) => e.method === 'PUT' && e.path.endsWith('/output'));
    expect(outputPuts).toHaveLength(1);
  });

  it('runIfEntrypoint module under the launcher: runs once via launcher, fail-loud handler stays silent', async () => {
    // Regression test for Task 1's `__anyEntrypointRunExecuted = true` line
    // inside run() (src/solidactions.ts). This fixture uses the CURRENT
    // recommended pattern — `SolidActions.runIfEntrypoint(wf, callerUrl)` —
    // rather than the legacy bare `SolidActions.run(wf)` the other fixtures
    // in this describe block use. Under launcherMain(), process.argv[1] is
    // NOT the fixture, so the module's own runIfEntrypoint() call is a SKIP
    // (records __anyRunSkippedForNonEntrypoint, never calls run()). The
    // launcher then selects and runs the descriptor itself via
    // SolidActions.run() — the ONLY place that records executed=true for
    // this scenario (Task 1's fix). Without that line, the fail-loud
    // process-exit handler's flag combination (skipped=true, executed=false)
    // would be armed to (mis)fire on a perfectly successful run.
    const RUN_ID = '00000000-0000-4000-8000-000000000e05';
    seedRun(RUN_ID);

    const capture = captureStreams();
    let exit: number | undefined;
    let stdout = '';
    let stderr = '';
    try {
      exit = await expectProcessExit(
        () => launcherMain(),
        mockEnv(RUN_ID, {
          WORKFLOW_ENTRY_FILE: fixturePath('launcher-run-if-entrypoint.ts'),
          WORKFLOW_ID: 'rie-under-launcher',
          WORKFLOW_INPUT: '{}',
        }),
      );
    } finally {
      ({ stdout, stderr } = capture.stop());
    }

    // Under launcherMain(), process.argv[1] is NOT the fixture, so the
    // module's own runIfEntrypoint() call is a skip; the launcher then runs
    // the descriptor itself — the workflow body runs exactly ONCE.
    expect(stdout.match(/RIE_UNDER_LAUNCHER_RAN/g)).toHaveLength(1);
    expect(stderr).not.toContain('FATAL: the dispatched one-shot module');
    // Exit code must come from the run, not a misfired fail-loud handler.
    expect(exit).toBe(0);

    // Prove the flag combination cannot fire the fail-loud handler: the
    // fixture's own runIfEntrypoint() call recorded a skip, and the
    // launcher's SolidActions.run(descriptor) call recorded executed=true —
    // that second fact is exactly what Task 1's line guards.
    const { executed, skipped } = __entrypointGuardFlags();
    expect(skipped).toBe(true);
    expect(executed).toBe(true);
    expect(__shouldFailLoudOnExit(true, executed, skipped)).toBe(false);
  });
});
