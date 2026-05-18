// jest globals — describe/it/expect are ambient; do NOT import from 'vitest'
import { defineWorkflow } from '../../src/invoke/define-workflow';

describe('defineWorkflow', () => {
  it('returns the workflow descriptor exposing run()', () => {
    const wf = defineWorkflow({ run: () => Promise.resolve('ok') });
    expect(typeof wf.run).toBe('function');
  });
  it('defining a workflow does not execute run()', () => {
    let ran = false;
    defineWorkflow({ run: () => { ran = true; return Promise.resolve('ok'); } });
    expect(ran).toBe(false);
  });
  it('rejects a definition missing run()', () => {
    // @ts-expect-error intentional
    expect(() => defineWorkflow({})).toThrow(/run/);
  });
});
