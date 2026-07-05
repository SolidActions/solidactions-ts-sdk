/**
 * serialize-error@8.1.0 drops the non-enumerable native Error.cause
 * (confirmed: `new Error(msg, { cause })` sets `cause` non-enumerable, and
 * serializeError()'s enumerable-only walk skips it). This wraps
 * serializeError() to copy a BOUNDED cause chain (depth <=3) into an
 * explicit enumerable property first, so deserializeError() on the far side
 * reconstructs it. Scope: src/invoke/invoke.ts:131 and
 * src/invoke/run-status-lifecycle.ts:120 only (legacy executor + conductor
 * paths are out of scope for this sweep).
 */
import { deserializeError, serializeError } from 'serialize-error';
import { serializeErrorWithCause } from '../../src/invoke/serialize-error-with-cause';

describe('serializeErrorWithCause', () => {
  test('baseline repro: plain serializeError DROPS a native Error(msg, {cause}) cause', () => {
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:1');
    const outer = new TypeError('fetch failed', { cause: inner });
    const serialized = serializeError(outer);
    const back = deserializeError(serialized);
    expect(back.cause).toBeUndefined(); // the bug, asserted as a baseline
  });

  test('round-trips a fetch-style error carrying .cause', () => {
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:1');
    const outer = new TypeError('fetch failed', { cause: inner });

    const serialized = serializeErrorWithCause(outer);
    const back = deserializeError(serialized);

    expect(back.message).toBe('fetch failed');
    expect((back.cause as Error)?.message).toBe('connect ECONNREFUSED 127.0.0.1:1');
  });

  test('bounds the chain at depth 3: a 4-hop cause chain keeps 3 hops, drops the 4th', () => {
    const e4 = new Error('e4 — should be dropped by the depth bound');
    const e3 = new Error('e3', { cause: e4 });
    const e2 = new Error('e2', { cause: e3 });
    const e1 = new Error('e1', { cause: e2 });
    const outer = new Error('outer', { cause: e1 });

    const serialized = serializeErrorWithCause(outer); // default depth = 3
    const back = deserializeError(serialized);

    expect(back.message).toBe('outer');
    expect((back.cause as Error).message).toBe('e1');
    expect(((back.cause as Error).cause as Error).message).toBe('e2');
    expect((((back.cause as Error).cause as Error).cause as Error).message).toBe('e3');
    // 4th hop (e4) is bounded out.
    expect((((back.cause as Error).cause as Error).cause as Error).cause).toBeUndefined();
  });

  test('no cause: output is identical to plain serializeError (no spurious "cause" key)', () => {
    const err = new Error('no cause here');
    const serialized = serializeErrorWithCause(err);
    expect(serialized).not.toHaveProperty('cause');
    expect(serialized.message).toBe('no cause here');
  });

  test('non-Error input passes through serializeError unchanged', () => {
    const input = 'just a string';
    expect(serializeErrorWithCause(input)).toBe(input);
  });
});
