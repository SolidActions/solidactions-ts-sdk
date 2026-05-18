// jest globals — describe/it/expect are ambient; do NOT import from 'vitest'
import { oneShotRuntimeAdapter, residentRuntimeAdapter } from '../../src/invoke/runtime-adapter';

it('one-shot: completed→0, failed→1, suspended→0', () => {
  expect(oneShotRuntimeAdapter.exitCodeFor({ status: 'completed', output: 1 })).toBe(0);
  expect(oneShotRuntimeAdapter.exitCodeFor({ status: 'failed', error: 'x' })).toBe(1);
  expect(oneShotRuntimeAdapter.exitCodeFor({ status: 'suspended', reason: 'sleep' })).toBe(0);
});

it('resident: returns the result verbatim', () => {
  const r = { status: 'suspended', reason: 'recv' } as const;
  expect(residentRuntimeAdapter.handle(r)).toBe(r);
});

it('one-shot: covers all remaining discriminants', () => {
  expect(oneShotRuntimeAdapter.exitCodeFor({ status: 'suspended', reason: 'recv' })).toBe(0);
  expect(oneShotRuntimeAdapter.exitCodeFor({ status: 'failed', error: 'y', phase: 'init' })).toBe(1);
});
