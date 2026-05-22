/**
 * T2 of the SolidActions SDK launcher rework —
 * `SolidActions.startWorkflow` resolution order in the invoke (one-shot) path.
 *
 * After T1, `defineWorkflow` stamps each descriptor with its resolved name and
 * populates `src/invoke/registry.ts`. After T2, the child-dispatch resolver
 * must accept ANY of:
 *   (a) a {@link WorkflowDescriptor} returned by `defineWorkflow` — looked up
 *       in the registry by `desc.name`;
 *   (b) a bare `string` registered name — looked up directly in the registry;
 *   (c) a legacy `registerWorkflow`-decorated function — registry first (by
 *       `fn.name`), THEN `getFunctionRegistration` as the last fallback for
 *       back-compat with old call sites.
 * None of (a)/(b)/(c) resolves ⇒ throws `WorkflowNotRegisteredError` with the
 * supplied identifier AND the sorted candidate-name list in the message.
 *
 * Anonymous-name synthesis (`#anonWorkflowSeq`, Task 2.4c) is retired — a
 * legacy `registerWorkflow(asyncArrow)` (no `name`, no `.name`) now throws at
 * registration time, citing `resolveWorkflowName`'s explicit-or-derived rule.
 *
 * Harness mirrors `tests/invoke/child-workflow.test.ts` (mock_server +
 * expectProcessExit). The child-create POST is observable via
 * `srv.lastChildCreate()` — that is the byte-faithful place to assert the
 * resolved child name lands on the wire.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
/* eslint-disable @typescript-eslint/require-await -- workflow fixtures are
 * async by contract even when a body has no await. */
import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { __clearRegistry, __getRegisteredWorkflows } from '../../src/invoke/registry';
import { WorkflowNotRegisteredError } from '../../src/error';
import { MockHttpServer } from '../../src/testing/mock_server';

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

/** Parent's run id — the one-shot ContextAdapter maps env→ctx.run.runUuid. */
const PARENT_RUN_ID = '00000000-0000-4000-8000-00000000d7a2';

beforeEach(() => {
  // Clear the registry so each test starts pristine — these tests register
  // children under stable names and depend on lookup miss / hit being
  // deterministic.
  __clearRegistry();

  srv.store.clear();
  srv.requestLog.length = 0;

  // Pre-seed the parent run row (matches child-workflow.test.ts harness).
  srv.store.workflows.set(PARENT_RUN_ID, {
    workflowUUID: PARENT_RUN_ID,
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
    applicationID: 'app-parent',
    input: null,
    output: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    recoveryAttempts: 0,
    priority: 0,
  });
  srv.store.operations.set(PARENT_RUN_ID, []);
});

function mockEnv(extra: Record<string, string>): Record<string, string> {
  return {
    SOLIDACTIONS_API_URL: srv.baseUrl,
    SOLIDACTIONS_API_KEY: 'test-api-key',
    SOLIDACTIONS_RUN_ID: PARENT_RUN_ID,
    SOLIDACTIONS__APPID: 'app-parent',
    ...extra,
  };
}

it('(a) startWorkflow(WorkflowDescriptor) — resolves via registry; child create POSTs the descriptor name', async () => {
  // Child is a pure `defineWorkflow` descriptor. T1 stamps `.name` and
  // populates the registry on import; T2 child-dispatch must find it by name.
  const child = defineWorkflow({
    name: 'child-a',
    run: async () => ({ doubled: 42 }),
  });

  // Parent passes the descriptor object directly to startWorkflow.
  const parent = SolidActions.registerWorkflow(
    async () => {
      const h = await SolidActions.startWorkflow(child)({ v: 21 });
      // Suspend on first run — the child hasn't completed yet.
      const r = (await h.getResult()) as { doubled: number };
      return { final: r.doubled };
    },
    { name: 'parent-descriptor' },
  );

  const code = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));

  // Suspended — exit 0, no terminal complete yet.
  expect(code).toBe(0);

  // The wire is the proof: the child-create POST carries the resolved name.
  const cc = srv.lastChildCreate()!;
  expect(cc).toBeTruthy();
  expect(cc.workflowName).toBe('child-a');
  expect(cc.workflowUUID).toBe(`${PARENT_RUN_ID}-child-0`);
  expect(typeof cc.childResultFunctionID).toBe('number');
});

it('(b) startWorkflow(string) — resolves via registry by direct name lookup', async () => {
  // Register the child by importing the defineWorkflow module body — name
  // `child-a` populates the registry.
  defineWorkflow({
    name: 'child-a',
    run: async () => ({ doubled: 42 }),
  });

  const parent = SolidActions.registerWorkflow(
    async () => {
      const h = await SolidActions.startWorkflow('child-a')({ v: 21 });
      const r = (await h.getResult()) as { doubled: number };
      return { final: r.doubled };
    },
    { name: 'parent-string' },
  );

  const code = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  const cc = srv.lastChildCreate()!;
  expect(cc).toBeTruthy();
  expect(cc.workflowName).toBe('child-a');
  expect(cc.workflowUUID).toBe(`${PARENT_RUN_ID}-child-0`);
});

it('(c) startWorkflow(legacyFn) — registerWorkflow-decorated child still dispatches via the registry', async () => {
  // Back-compat: a legacy `registerWorkflow` wrapper with an explicit `name`
  // populates the SAME registry under that name (T1 invariant). The parent
  // passes the WRAPPER (a function, not the bare impl) — the resolver finds
  // it by `wrapper.name`-fallback or `getFunctionRegistration`.
  const child = SolidActions.registerWorkflow(
    async (input: { v: number }) => ({ doubled: input.v * 2 }),
    { name: 'child-b' },
  );

  const parent = SolidActions.registerWorkflow(
    async () => {
      const h = await SolidActions.startWorkflow(child)({ v: 21 });
      const r = (await h.getResult()) as { doubled: number };
      return { final: r.doubled };
    },
    { name: 'parent-legacy-fn' },
  );

  const code = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  const cc = srv.lastChildCreate()!;
  expect(cc).toBeTruthy();
  expect(cc.workflowName).toBe('child-b');
});

it('(d/string) startWorkflow("does-not-exist") — throws WorkflowNotRegisteredError carrying supplied identifier + sorted candidate list', async () => {
  // Pre-populate the registry with TWO known candidates so the error message
  // shows what was available next to what was supplied. The candidates land
  // in sort order regardless of registration order.
  defineWorkflow({ name: 'child-z', run: async () => 'z' });
  defineWorkflow({ name: 'child-a', run: async () => 'a' });

  const parent = SolidActions.registerWorkflow(
    async () => {
      // The throw happens inside the workflow body during invoke().
      await SolidActions.startWorkflow('does-not-exist')({ v: 1 });
      return 'unreachable';
    },
    { name: 'parent-unknown-string' },
  );

  const code = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));

  // The workflow body threw → run() reports `failed` → exit 1.
  expect(code).toBe(1);

  const errorPut = srv.requestLog.find(
    (e) => e.method === 'PUT' && /\/runs\/status\/[^/]+\/error$/.test(e.path),
  );
  expect(errorPut).toBeTruthy();
  const body = errorPut!.body as { error: string; status: string };
  // status: ERROR per legacy parity (set by #reportOneShotTerminalState).
  expect(body.status).toBe('ERROR');
  // The error payload is SolidActionsJSON + serialize-error stringified —
  // assert substrings only (the message must AI-debug-friendly).
  expect(body.error).toContain("Workflow 'does-not-exist' is not registered");
  // Sorted candidate list embedded in message: alphabetical, NOT registration
  // order. The parent-workflow `parent-unknown-string` was also registered
  // before dispatch (via SolidActions.registerWorkflow → registry) and lands
  // in the candidate list too — assert the sorted slice for child-a/child-z
  // is intact (parent name sorts last), and prove sortedness via the full
  // slice.
  expect(body.error).toContain('[child-a, child-z, parent-unknown-string]');
  expect(body.error).toContain('Did the parent forget to import the child module?');
});

it('(d/descriptor) startWorkflow(unregisteredDescriptor) — throws WorkflowNotRegisteredError citing the descriptor name', async () => {
  // Two registered candidates, one unregistered descriptor passed in. The
  // descriptor has a `.name` but its name is NOT in the registry (e.g. the
  // caller built a `{name, run}` literal by hand instead of through
  // defineWorkflow — also covers the case where a name is shadowed/typo'd).
  defineWorkflow({ name: 'real-a', run: async () => 'a' });
  defineWorkflow({ name: 'real-b', run: async () => 'b' });
  const unregistered = { name: 'phantom', run: async () => 'never' };

  const parent = SolidActions.registerWorkflow(
    async () => {
      // Cast through `unknown` to a string so the overload resolves to the
      // descriptor/string branch — the descriptor object's runtime shape is
      // what the resolver inspects. The pre-`as string` cast is only to
      // satisfy TS overload selection; the runtime value is the unregistered
      // descriptor object and the resolver classifies it as descriptor (a),
      // not string (b).
      const desc = unregistered as unknown as string;
      await SolidActions.startWorkflow(desc)({ v: 1 });
      return 'unreachable';
    },
    { name: 'parent-unknown-desc' },
  );

  const code = await expectProcessExit(() => SolidActions.run(parent), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(1);
  const errorPut = srv.requestLog.find(
    (e) => e.method === 'PUT' && /\/runs\/status\/[^/]+\/error$/.test(e.path),
  );
  expect(errorPut).toBeTruthy();
  const body = errorPut!.body as { error: string; status: string };
  expect(body.status).toBe('ERROR');
  expect(body.error).toContain("Workflow 'phantom' is not registered");
  // Sorted candidate list — alphabetical, not registration order. The parent
  // (`parent-unknown-desc`) is also registered, so it lands in the list too;
  // assert the FULL sorted slice so any deviation (e.g. reg-order leak) is
  // caught.
  expect(body.error).toContain('[parent-unknown-desc, real-a, real-b]');
});

it('(e) anon synthesis is gone — registerWorkflow(asyncArrow) with no name AND no fn.name throws via resolveWorkflowName', () => {
  // The legacy shim used to silently mint `__anon_workflow_<n>`. After T2 /
  // Task 2.4c the same call surfaces the registry's explicit-or-derived
  // rule as a clear error at REGISTRATION time (not deep inside dispatch).
  //
  // `() => Promise.resolve(...)` returned from a factory has `.name === ''`
  // (no variable/property assignment context to inherit a name from).
  function makeAnonRun(): () => Promise<string> {
    return () => Promise.resolve('never');
  }
  const anon = makeAnonRun();
  expect(anon.name).toBe('');

  expect(() => SolidActions.registerWorkflow(anon)).toThrow(
    /defineWorkflow requires either an explicit name or a named run function/,
  );

  // And the registry stayed pristine — the throw fired BEFORE any registry
  // entry was created (no half-registered state).
  expect(__getRegisteredWorkflows()).toHaveLength(0);
});

it('WorkflowNotRegisteredError instance shape — code 38, suppliedIdentifier + registeredNames carried as fields', () => {
  // Hook the resolver outside of a workflow body to make the synchronous
  // shape easy to assert: T2's "no invoke scope + descriptor" guard in the
  // legacy path throws SolidActionsNotRegisteredError (a different class).
  // The shape we want is the invoke-scope error; build it directly to assert
  // the schema the SDK guarantees to consumers (error code is part of the
  // public surface — runners/CLI key off it).
  const err = new WorkflowNotRegisteredError('child-x', ['a', 'b', 'c']);
  expect(err.suppliedIdentifier).toBe('child-x');
  expect(err.registeredNames).toEqual(['a', 'b', 'c']);
  expect((err as unknown as { solidActionsErrorCode: number }).solidActionsErrorCode).toBe(38);
  expect(err.message).toContain("Workflow 'child-x' is not registered");
  expect(err.message).toContain('[a, b, c]');
});
