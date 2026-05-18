// jest globals — describe/it/expect are ambient; do NOT import from 'vitest'
import { defineWorkflow } from '../../src/invoke/define-workflow';

describe('defineWorkflow', () => {
  it('returns a workflow descriptor exposing run(), no side effects on import', () => {
    let ran = false;
    const wf = defineWorkflow({ async run() { ran = true; return 'ok'; } });
    expect(typeof wf.run).toBe('function');
    expect(ran).toBe(false); // defining must not execute
  });
  it('rejects a definition missing run()', () => {
    // @ts-expect-error intentional
    expect(() => defineWorkflow({})).toThrow(/run/);
  });
});
