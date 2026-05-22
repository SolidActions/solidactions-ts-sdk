/**
 * T1 — workflow registry: defineWorkflow (and legacy registerWorkflow)
 * populate a process-global registry, and importing a workflow module is
 * side-effect-free w.r.t. execution.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
import { defineWorkflow } from '../../src/invoke/define-workflow';
import {
  __getRegisteredWorkflow,
  __getRegisteredWorkflows,
  __clearRegistry,
} from '../../src/invoke/registry';
import { WorkflowAlreadyRegisteredError } from '../../src/error';
import { SolidActions } from '../../src/solidactions';
import { getFunctionRegistration } from '../../src/decorators';

describe('T1 — workflow registry (defineWorkflow + legacy registerWorkflow)', () => {
  beforeEach(() => {
    __clearRegistry();
  });

  it('(a) defineWorkflow with explicit name populates the registry', () => {
    const wf = defineWorkflow({
      name: 'wf-a',
      run: () => Promise.resolve('ok'),
    });

    expect(wf.name).toBe('wf-a');
    expect(__getRegisteredWorkflow('wf-a')).toBe(wf);
    expect(__getRegisteredWorkflows()).toContain(wf);
  });

  it('(b) defineWorkflow derives the name from a named run function', () => {
    function wfB() {
      return Promise.resolve('ok');
    }
    const wf = defineWorkflow({ run: wfB });

    expect(wf.name).toBe('wfB');
    expect(__getRegisteredWorkflow('wfB')).toBe(wf);
  });

  it('(c) defineWorkflow with a truly anonymous run function and no explicit name throws a clear error', () => {
    // Returning an arrow from a factory strips JS's automatic name inference
    // (no variable / property assignment context), so the resulting function
    // has `.name === ''`. Plain `run: () => Promise.resolve('ok')` inside an
    // object literal would be auto-named `'run'` (non-empty) and would pass —
    // that's spec behavior; the throw fires only when `.name` is empty.
    function makeAnon(): () => Promise<string> {
      return () => Promise.resolve('ok');
    }
    const anon = makeAnon();
    expect(anon.name).toBe('');

    expect(() =>
      defineWorkflow({
        run: anon,
      }),
    ).toThrow(/defineWorkflow requires either an explicit name or a named run function/);

    expect(__getRegisteredWorkflows()).toHaveLength(0);
  });

  it('(d) re-registering the SAME descriptor under the same name is a no-op (idempotent)', () => {
    const desc = {
      name: 'wf-idem',
      run: () => Promise.resolve('ok'),
    };

    const first = defineWorkflow(desc);
    const second = defineWorkflow(desc);

    expect(first).toBe(second);
    expect(__getRegisteredWorkflows()).toHaveLength(1);
    expect(__getRegisteredWorkflow('wf-idem')).toBe(desc);
  });

  it('(d.1) re-registering a different descriptor whose run is the SAME function is also idempotent', () => {
    function sharedRun() {
      return Promise.resolve('ok');
    }
    defineWorkflow({ name: 'wf-shared', run: sharedRun });
    // Distinct descriptor object, same run function (e.g. caller re-built the
    // wrapper but reused the run impl). Treated as idempotent: no throw, no
    // duplicate entry.
    defineWorkflow({ name: 'wf-shared', run: sharedRun });

    expect(__getRegisteredWorkflows()).toHaveLength(1);
  });

  it('(e) re-registering a different descriptor under the same name throws WorkflowAlreadyRegisteredError', () => {
    defineWorkflow({ name: 'wf-conflict', run: () => Promise.resolve('first') });

    let err: unknown;
    try {
      defineWorkflow({ name: 'wf-conflict', run: () => Promise.resolve('second') });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkflowAlreadyRegisteredError);
    expect((err as WorkflowAlreadyRegisteredError).workflowName).toBe('wf-conflict');
    expect((err as Error).message).toContain('wf-conflict');
    expect(__getRegisteredWorkflows()).toHaveLength(1);
  });

  it('(f) legacy SolidActions.registerWorkflow populates the same registry and keeps back-compat', () => {
    function legacyImpl() {
      return Promise.resolve(42);
    }
    const wrapped = SolidActions.registerWorkflow(legacyImpl, { name: 'wf-c' });

    // New registry: name 'wf-c' resolves to a descriptor wrapping legacyImpl.
    const descriptor = __getRegisteredWorkflow('wf-c');
    expect(descriptor).toBeDefined();
    expect(descriptor?.name).toBe('wf-c');

    // Legacy registration path is preserved: the returned wrapper is still
    // tracked by getFunctionRegistration so the legacy executor / one-shot
    // run() path keeps recovering origFunction unchanged.
    const legacyReg = getFunctionRegistration(wrapped);
    expect(legacyReg).toBeDefined();
  });

  it('(g) importing a workflow module is import-pure: no process.exit, no exit listeners', async () => {
    // Capture process.exit and process.on('exit') listener additions during
    // the dynamic import. The jest.setup.ts interceptor will throw if exit is
    // called while armed; we additionally count direct calls and 'exit'
    // listener installs as a belt-and-suspenders proof.
    const exitCalls: number[] = [];
    const exitListenersAdded: NodeJS.SignalsListener[] = [];

    const g = globalThis as Record<string, unknown>;
    const priorArmed = g.__processExitArmed;
    g.__processExitArmed = true;

    const realExit = process.exit.bind(process);
    const realOn = process.on.bind(process);

    // Wrap process.exit — when armed the interceptor throws, but we still
    // record the call attempt here so the assertion is independent.
    process.exit = ((code?: number) => {
      exitCalls.push(code ?? 0);
      return realExit(code);
    }) as typeof process.exit;

    // Wrap process.on to track ANY new 'exit' listener installs during import.
    process.on = ((event: string | symbol, listener: NodeJS.SignalsListener) => {
      if (event === 'exit') {
        exitListenersAdded.push(listener);
      }
      return realOn(event as 'exit', listener);
    }) as typeof process.on;

    try {
      // Import a module that uses defineWorkflow at module scope. We use a
      // dynamic import so the side-effects (if any) are observable WITHIN
      // the wrapped scope above.
      await import('./fixtures/wf-pure-import-fixture');
    } finally {
      process.exit = realExit;
      process.on = realOn;
      g.__processExitArmed = priorArmed;
    }

    expect(exitCalls).toEqual([]);
    expect(exitListenersAdded).toEqual([]);
    // And the registry MUST contain the fixture's workflow as the sole
    // observable effect of the import.
    expect(__getRegisteredWorkflow('wf-pure-fixture')).toBeDefined();
  });

  it('(h) neither defineWorkflow nor SolidActions.registerWorkflow logs a deprecation warning on import', () => {
    const warnCalls: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      defineWorkflow({ name: 'wf-no-warn-1', run: () => Promise.resolve('ok') });
      SolidActions.registerWorkflow(function wfNoWarn2() {
        return Promise.resolve('ok');
      });
    } finally {
      console.warn = realWarn;
    }

    expect(warnCalls).toEqual([]);
  });
});
