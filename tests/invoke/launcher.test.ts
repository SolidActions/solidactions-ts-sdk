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
