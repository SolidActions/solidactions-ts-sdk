process.env.PGPASSWORD = process.env.PGPASSWORD ?? 'dbos';
process.env.FOO = 'foo';
process.env.BAR = 'bar';
process.env.BAZ = 'baz';
process.env.C = 'c';

// Observable process.exit interceptor.
// When (globalThis as any).__processExitArmed is truthy, calling process.exit(code)
// throws a ProcessExitSignal instead of killing the process, making it observable
// in tests. When not armed, it delegates to the real process.exit so all
// non-durable tests behave exactly as before.
(function installProcessExitInterceptor() {
  // Guard: only install once (jest re-runs setupFiles across workers but each
  // worker is a fresh Node context so the symbol acts as a per-worker sentinel).
  const INSTALLED_KEY = '__processExitInterceptorInstalled';
  if ((globalThis as Record<string, unknown>)[INSTALLED_KEY]) {
    return;
  }
  (globalThis as Record<string, unknown>)[INSTALLED_KEY] = true;

  const realExit = process.exit.bind(process);

  // process.exit is typed as (code?: number) => never; the armed path satisfies
  // `never` by throwing; the unarmed path delegates to the real exit (also never).
  (process as NodeJS.Process).exit = ((code?: number): never => {
    if ((globalThis as Record<string, unknown>).__processExitArmed) {
      const exitCode = code ?? 0;
      const err: NodeJS.ErrnoException = new Error(`process.exit called with code ${exitCode}`);
      err.name = 'ProcessExitSignal';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).code = exitCode;
      throw err;
    }
    return realExit(code);
  }) as typeof process.exit;
})();
