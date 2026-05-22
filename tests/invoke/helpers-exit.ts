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
 * Optional `env` argument (the planned 0.1a extension point): if given, each key
 * is set on `process.env` before running `fn` and restored afterwards in the
 * `finally` (keys that were absent before are deleted; keys that had a value are
 * restored to it). Backward compatible — callers that pass no `env` are
 * unaffected.
 *
 * @param fn  - Function under test that must call process.exit(). If it completes
 *              without calling process.exit(), expectProcessExit throws.
 * @param env - Optional env keys to set for the duration of the call, restored
 *              to their prior values (or deleted) afterwards.
 * @returns     The numeric exit code passed to process.exit().
 */
export async function expectProcessExit(
  fn: () => unknown,
  env?: Record<string, string>,
): Promise<number> {
  const g = globalThis as Record<string, unknown>;
  const prior = g.__processExitArmed;
  g.__processExitArmed = true;

  // Snapshot prior env values so they can be restored (or deleted) afterwards.
  const priorEnv: Record<string, string | undefined> = {};
  if (env) {
    for (const key of Object.keys(env)) {
      priorEnv[key] = process.env[key];
      process.env[key] = env[key];
    }
  }

  try {
    const result = fn();
    if (
      result !== null &&
      result !== undefined &&
      typeof (result as Promise<unknown>).then === 'function'
    ) {
      await (result as Promise<unknown>);
    }
  } catch (err: unknown) {
    // The interceptor throws a plain Error with name 'ProcessExitSignal' and a
    // `code` property (to avoid the circular-import problem of referencing this
    // module from jest.setup.ts). We re-wrap it as a proper ProcessExitSignal so
    // callers get a typed value.
    if (err instanceof Error && err.name === 'ProcessExitSignal') {
      const code = (err as Error & { code?: unknown }).code;
      if (typeof code === 'number') {
        return code;
      }
    }
    throw err;
  } finally {
    g.__processExitArmed = prior;
    if (env) {
      for (const key of Object.keys(env)) {
        if (priorEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = priorEnv[key];
        }
      }
    }
  }

  throw new Error(
    'expectProcessExit: fn completed without calling process.exit(). ' +
      'Ensure the function under test calls process.exit() on the code path being tested.',
  );
}
