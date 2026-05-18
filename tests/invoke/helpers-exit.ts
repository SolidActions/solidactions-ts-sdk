/**
 * Helpers for testing code that calls process.exit().
 *
 * The interceptor is installed once in jest.setup.ts. When armed via
 * `expectProcessExit`, calling process.exit(code) throws a ProcessExitSignal
 * instead of killing the worker, making exit codes observable in unit tests.
 */

/**
 * Thrown by the jest.setup.ts interceptor when armed and process.exit() is called.
 * Carries the numeric exit code so tests can assert on it.
 */
export class ProcessExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`process.exit called with code ${code}`);
    this.name = 'ProcessExitSignal';
    this.code = code;
  }
}

/**
 * Arm the process.exit interceptor, run `fn`, and return the exit code.
 *
 * The interceptor (installed in jest.setup.ts) checks `globalThis.__processExitArmed`;
 * when truthy it throws an error with `name === 'ProcessExitSignal'` and a `code`
 * property rather than calling the real `process.exit`. This helper bridges that
 * thrown error back to a typed `ProcessExitSignal` so callers get a clean API.
 *
 * The arm flag is always restored in a `finally`, so nested or sequenced calls
 * are safe.
 *
 * Forward-compat note: an optional second argument (e.g. `env?: Record<string, string>`)
 * can be added later to snapshot/restore process.env entries around the call without
 * changing the signature of existing callers.
 *
 * @param fn - Function under test that must call process.exit(). If it completes
 *             without calling process.exit(), expectProcessExit throws.
 * @returns   The numeric exit code passed to process.exit().
 */
export async function expectProcessExit(fn: () => unknown | Promise<unknown>): Promise<number> {
  const g = globalThis as Record<string, unknown>;
  const prior = g.__processExitArmed;
  g.__processExitArmed = true;

  try {
    const result = fn();
    if (result != null && typeof (result as Promise<unknown>).then === 'function') {
      await (result as Promise<unknown>);
    }
  } catch (err: unknown) {
    // The interceptor throws a plain Error with name 'ProcessExitSignal' and a
    // `code` property (to avoid the circular-import problem of referencing this
    // module from jest.setup.ts). We re-wrap it as a proper ProcessExitSignal so
    // callers get a typed value.
    if (
      err instanceof Error &&
      err.name === 'ProcessExitSignal' &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof (err as any).code === 'number'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (err as any).code as number;
    }
    throw err;
  } finally {
    g.__processExitArmed = prior;
  }

  throw new Error(
    'expectProcessExit: fn completed without calling process.exit(). ' +
      'Ensure the function under test calls process.exit() on the code path being tested.',
  );
}
