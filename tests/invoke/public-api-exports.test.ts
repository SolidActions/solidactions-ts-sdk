/**
 * T8 follow-up #1 — verify defineWorkflow and its companion types are
 * reachable from the SDK's public entry point (src/index.ts).
 *
 * These tests import from '../../src/index' (simulating
 * `import { defineWorkflow } from '@solidactions/sdk'`) and exercise the
 * public contract without touching internal registry helpers.
 */

// jest globals — describe/it/expect are ambient; do NOT import from 'vitest'
import {
  defineWorkflow,
  WorkflowAlreadyRegisteredError,
  WorkflowNotRegisteredError,
} from '../../src/index';
import type {
  WorkflowDescriptor,
  InvokeCtx,
  InvokeResult,
  DurablePrimitives,
  ConnectionVar,
  VarValue,
} from '../../src/index';
import { __clearRegistry } from '../../src/invoke/registry';

describe('public API: defineWorkflow exported from package root', () => {
  beforeEach(() => {
    __clearRegistry();
  });

  it('defineWorkflow is importable from the package root and returns a descriptor with the correct name', () => {
    const wf = defineWorkflow({ name: 'myWorkflow', run: async () => 0 });
    expect(wf.name).toBe('myWorkflow');
  });

  it('defineWorkflow descriptor exposes the run function', () => {
    const run = async () => 'result';
    const wf = defineWorkflow({ name: 'runExposed', run });
    expect(wf.run).toBe(run);
  });

  it('defineWorkflow infers name from named function', () => {
    async function namedRun() { return true; }
    const wf = defineWorkflow({ run: namedRun });
    expect(wf.name).toBe('namedRun');
  });

  it('defineWorkflow throws on duplicate registration of a different descriptor', () => {
    defineWorkflow({ name: 'duplicate', run: async () => 1 });
    expect(() => defineWorkflow({ name: 'duplicate', run: async () => 2 }))
      .toThrow(WorkflowAlreadyRegisteredError);
  });

  it('WorkflowAlreadyRegisteredError is exported from the package root', () => {
    expect(WorkflowAlreadyRegisteredError).toBeDefined();
    const err = new WorkflowAlreadyRegisteredError('myWorkflow');
    expect(err).toBeInstanceOf(WorkflowAlreadyRegisteredError);
    expect(err.workflowName).toBe('myWorkflow');
  });

  it('WorkflowNotRegisteredError is exported from the package root', () => {
    expect(WorkflowNotRegisteredError).toBeDefined();
    const err = new WorkflowNotRegisteredError('missingWf', ['wfA', 'wfB']);
    expect(err).toBeInstanceOf(WorkflowNotRegisteredError);
    expect(err.suppliedIdentifier).toBe('missingWf');
    expect(err.registeredNames).toEqual(['wfA', 'wfB']);
  });

  it('type-check: WorkflowDescriptor is usable as an annotation', () => {
    // If this compiles, the type is exported correctly.
    const descriptor: WorkflowDescriptor<string, number> = {
      name: 'typed',
      run: async (_ctx: InvokeCtx<string> & DurablePrimitives) => 42,
    };
    const registered = defineWorkflow(descriptor);
    expect(registered.name).toBe('typed');
  });

  it('type-check: InvokeResult union is usable as an annotation', () => {
    // Runtime check that the union shape is correct.
    const completed: InvokeResult<number> = { status: 'completed', output: 99 };
    const suspended: InvokeResult = { status: 'suspended', reason: 'sleep' };
    const failed: InvokeResult = { status: 'failed', error: new Error('boom') };
    const cancelled: InvokeResult = { status: 'cancelled' };
    expect(completed.status).toBe('completed');
    expect(suspended.status).toBe('suspended');
    expect(failed.status).toBe('failed');
    expect(cancelled.status).toBe('cancelled');
  });

  it('type-check: ConnectionVar and VarValue are usable as annotations', () => {
    const cv: ConnectionVar = { key: 'k', proxyUrl: 'https://proxy', proxyToken: 'tok' };
    const strVar: VarValue = 'plain-string';
    const connVar: VarValue = cv;
    expect(cv.key).toBe('k');
    expect(strVar).toBe('plain-string');
    expect((connVar as ConnectionVar).proxyToken).toBe('tok');
  });
});
