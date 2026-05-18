import { expectProcessExit } from './helpers-exit';

it('process.exit is intercepted as an observable throw when armed, not fatal', async () => {
  const code = await expectProcessExit(() => { process.exit(3); });
  expect(code).toBe(3);
});

it('process.exit is unaffected (default) when the interceptor is not armed', () => {
  // sanity: the override is opt-in so non-durable tests behave normally
  expect(typeof process.exit).toBe('function');
});
