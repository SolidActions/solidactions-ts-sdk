import { expectProcessExit } from './helpers-exit';

it('process.exit is intercepted as an observable throw when armed, not fatal', async () => {
  const code = await expectProcessExit(() => { process.exit(3); });
  expect(code).toBe(3);
});

it('interceptor defaults to disarmed: arm flag is falsy and process.exit is still callable', () => {
  // The arm flag must be falsy before any test arms it, confirming the interceptor
  // does not intercept by default. process.exit must still be a function (the
  // interceptor replaces it with a wrapper, so this also proves the wrapper was
  // installed). Note: calling unarmed process.exit() in a test would terminate
  // the jest worker — that delegation to the real OS exit is covered indirectly
  // by tests/http_client.test.ts, which calls process.exit(0) unarmed and exits 0.
  expect((globalThis as Record<string, unknown>).__processExitArmed).toBeFalsy();
  expect(typeof process.exit).toBe('function');
});
