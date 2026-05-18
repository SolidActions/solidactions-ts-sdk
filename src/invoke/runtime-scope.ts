/**
 * runtime-scope — the AsyncLocalStorage holder for invoke()-mode execution.
 *
 * The legacy run() path keeps its own separate context (src/context.ts) and is
 * NOT touched here. Invoke mode is fully self-contained: every invoke() call
 * enters a fresh scope carrying its per-request system database plus the
 * per-invoke durable runtime params (workflow id, identity, function-id
 * counter). Durable primitives delegate to whatever is in the active scope, so
 * concurrent invoke() calls never share identity or step counters.
 *
 * getCurrentExecutor() / getCurrentRuntimeParams() THROW if called with no
 * active scope: invoke mode requires the scope, and a missing scope is a
 * programming error (a primitive used outside invoke()), not something to
 * silently paper over with a global fallback.
 */

import { AsyncLocalStorage } from 'async_hooks';
// Type-only: importing the value would create a runtime import cycle
// (runtime-scope -> invoke-system-database -> http_system_database -> workflow
// -> solidactions -> runtime-scope). InvokeSystemDatabase is used only in type
// position here, so `import type` (erased at runtime) keeps this module
// cycle-free.
import type { InvokeSystemDatabase } from './invoke-system-database';
import type { DurablePrimitives } from './types';

/**
 * Per-invoke durable runtime parameters. Identity is injected from the caller's
 * InvokeCtx — never read from process.env or module globals.
 */
export interface RuntimeParams {
  /** Stable workflow id for this run (the trigger's run UUID). */
  readonly workflowID: string;
  /** Executor identity for this invocation. */
  readonly executorID: string;
  /** Application id for this invocation (from ctx.app.appId — never a global). */
  readonly appId: string;
  /** Application version string for this invocation. */
  readonly appVersion: string;
  /**
   * Monotonic durable function-id counter for this run. Each durable operation
   * (step/sleep/recv/send) consumes the next id; mutated in place so a single
   * run's primitives stay correctly ordered.
   */
  functionIDCounter: number;
}

/**
 * What lives in the invoke ALS: the per-request execution engine
 * (InvokeSystemDatabase — see invoke.ts for why this, not the legacy
 * SolidActionsExecutor) plus the durable runtime params.
 */
export interface RuntimeScope {
  readonly executor: InvokeSystemDatabase;
  readonly runtimeParams: RuntimeParams;
  /**
   * Task 2.3: the durable primitives invoke() built for this run. Exposed on
   * the scope so the legacy `SolidActions.runStep` / `SolidActions.sleepms`
   * free-functions can delegate to the EXACT same closures (single source of
   * truth) when a legacy-registered workflow body runs under the one-shot
   * run() path. Optional: invoke() sets it; callers that build a scope without
   * primitives (none today) simply won't have the bridge available.
   */
  readonly primitives?: DurablePrimitives;
}

const invokeScope = new AsyncLocalStorage<RuntimeScope>();

/**
 * Run `fn` with `scope` active. Used by invoke(); legacy run() must not use this.
 */
export function runInScope<R>(scope: RuntimeScope, fn: () => Promise<R>): Promise<R> {
  return invokeScope.run(scope, fn);
}

/** The active invoke scope, or undefined when not inside invoke(). */
export function getCurrentScope(): RuntimeScope | undefined {
  return invokeScope.getStore();
}

function requireScope(caller: string): RuntimeScope {
  const scope = invokeScope.getStore();
  if (!scope) {
    throw new Error(
      `${caller}() called with no active invoke scope. Durable primitives are only ` +
        `available inside invoke(); the legacy run() path uses its own context.`,
    );
  }
  return scope;
}

// Consumed by Task 2.4 (route legacy identity via ALS); intentionally unused on the invoke() path in Phase 1.
/** The per-request execution engine for the active invoke scope. Throws if none. */
export function getCurrentExecutor(): InvokeSystemDatabase {
  return requireScope('getCurrentExecutor').executor;
}

/** The durable runtime params for the active invoke scope. Throws if none. */
export function getCurrentRuntimeParams(): RuntimeParams {
  return requireScope('getCurrentRuntimeParams').runtimeParams;
}

/**
 * The durable primitives for the active invoke scope (Task 2.3 compat bridge),
 * or undefined when not inside invoke() OR when the scope carries no primitives.
 * Used by SolidActions.runStep/sleepms to delegate legacy free-function calls
 * onto invoke()'s primitives without duplicating record-or-replay logic.
 */
export function getCurrentPrimitives(): DurablePrimitives | undefined {
  return invokeScope.getStore()?.primitives;
}

/**
 * Consume and return the next durable function id for the active invoke scope.
 * Mutates the scope's counter in place so step/sleep/recv/send within one run
 * get stable, monotonically increasing ids.
 */
export function nextFunctionID(): number {
  const params = requireScope('nextFunctionID').runtimeParams;
  return params.functionIDCounter++;
}
