process.env.PGPASSWORD = process.env.PGPASSWORD ?? 'dbos';
process.env.FOO = 'foo';
process.env.BAR = 'bar';
process.env.BAZ = 'baz';
process.env.C = 'c';

// Observable process.exit interceptor. No test can end the Jest process:
// process.exit(code) always throws. When (globalThis as any).__processExitArmed
// is truthy (set by expectProcessExit) it throws a ProcessExitSignal, making the
// exit code observable. When not armed it throws an Error that fails the test.
(function installProcessExitInterceptor() {
  // Guard: only install once (jest re-runs setupFiles across workers but each
  // worker is a fresh Node context so the symbol acts as a per-worker sentinel).
  const INSTALLED_KEY = '__processExitInterceptorInstalled';
  if ((globalThis as Record<string, unknown>)[INSTALLED_KEY]) {
    return;
  }
  (globalThis as Record<string, unknown>)[INSTALLED_KEY] = true;

  // process.exit is typed as (code?: number) => never; throwing satisfies `never`.
  (process as NodeJS.Process).exit = ((code?: number): never => {
    const exitCode = code ?? 0;
    if ((globalThis as Record<string, unknown>).__processExitArmed) {
      const err: Error = new Error(`process.exit called with code ${exitCode}`);
      err.name = 'ProcessExitSignal';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).code = exitCode;
      throw err;
    }
    throw new Error(
      `process.exit(${exitCode}) was called outside expectProcessExit. A test must use expectProcessExit ` +
        '(tests/invoke/helpers-exit.ts) to run code that exits the process.',
    );
  }) as typeof process.exit;
})();
