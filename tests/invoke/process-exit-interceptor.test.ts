import { expectProcessExit } from './helpers-exit';

it('process.exit is intercepted as an observable throw when armed, not fatal', async () => {
  const code = await expectProcessExit(() => { process.exit(3); });
  expect(code).toBe(3);
});

it('interceptor defaults to disarmed: the arm flag is falsy outside expectProcessExit', () => {
  expect((globalThis as Record<string, unknown>).__processExitArmed).toBeFalsy();
  expect(typeof process.exit).toBe('function');
});

it('an unarmed process.exit throws an error naming the code and expectProcessExit instead of ending the run', () => {
  expect((globalThis as Record<string, unknown>).__processExitArmed).toBeFalsy();

  let thrown: unknown;
  try {
    process.exit(7);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).name).not.toBe('ProcessExitSignal');
  expect((thrown as Error).message).toContain('process.exit(7)');
  expect((thrown as Error).message).toContain('expectProcessExit');
});

it('an unarmed process.exit with no argument names exit code 0', () => {
  expect((globalThis as Record<string, unknown>).__processExitArmed).toBeFalsy();

  expect(() => process.exit()).toThrow('process.exit(0)');
});
