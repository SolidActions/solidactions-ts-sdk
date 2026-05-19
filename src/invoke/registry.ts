/**
 * T1 of the SolidActions SDK launcher rework — workflow registry.
 *
 * A module-scope `Map<string, WorkflowDescriptor>` populated by `defineWorkflow`
 * and the legacy `SolidActions.registerWorkflow` shim. T2's `startWorkflow`
 * child-dispatch resolves either registration form against this same map.
 *
 * Invariants:
 *  - Importing a workflow module MUST be side-effect-free w.r.t. execution
 *    (no env reads, no status writes, no `process.exit`, no warnings). The
 *    only observable effect of registration is an entry in this map.
 *  - Re-registering the SAME descriptor under the same name is a no-op
 *    (idempotent — supports re-imported modules under Jest etc.).
 *  - Re-registering a DIFFERENT descriptor under the same name throws
 *    {@link WorkflowAlreadyRegisteredError}.
 */
import { WorkflowAlreadyRegisteredError } from '../error';
import type { WorkflowDescriptor } from './types';

/** Process-global registry, keyed by resolved registration name. */
const registry = new Map<string, WorkflowDescriptor<unknown, unknown>>();

/**
 * Register a workflow descriptor under the given resolved name.
 *
 * - Idempotent on re-registration of the SAME descriptor (referential equality
 *   on the descriptor object, OR same `run` function — re-import covers both).
 * - Throws {@link WorkflowAlreadyRegisteredError} on a different descriptor.
 *
 * The descriptor's `name` field is annotated with the resolved name as a side
 * effect (so callers reading the descriptor downstream — T2's child dispatch —
 * see the registered name directly).
 */
export function registerWorkflowDescriptor<I, O>(
  desc: WorkflowDescriptor<I, O>,
  resolvedName: string,
): WorkflowDescriptor<I, O> {
  const existing = registry.get(resolvedName);
  if (existing) {
    const sameDescriptor =
      existing === (desc as unknown as WorkflowDescriptor<unknown, unknown>) ||
      existing.run === (desc.run as unknown as WorkflowDescriptor<unknown, unknown>['run']);
    if (!sameDescriptor) {
      throw new WorkflowAlreadyRegisteredError(resolvedName);
    }
    // Idempotent: stamp the name on the caller's descriptor and return.
    desc.name = resolvedName;
    return desc;
  }
  desc.name = resolvedName;
  registry.set(resolvedName, desc as unknown as WorkflowDescriptor<unknown, unknown>);
  return desc;
}

/**
 * Test-only accessor: list every registered workflow descriptor.
 *
 * Exported with the `__` prefix per the convention used by
 * `__shouldFailLoudOnExit` / `__failLoudExitCode` in `src/solidactions.ts`:
 * available for tests, NOT re-exported through `src/index.ts`.
 */
export function __getRegisteredWorkflows(): WorkflowDescriptor<unknown, unknown>[] {
  return Array.from(registry.values());
}

/**
 * Test-only accessor: look up a registered workflow by resolved name.
 */
export function __getRegisteredWorkflow(name: string): WorkflowDescriptor<unknown, unknown> | undefined {
  return registry.get(name);
}

/**
 * Test-only reset: clear the registry. Used by tests that must start with a
 * pristine registry. NOT a runtime concern — never call from production code.
 */
export function __clearRegistry(): void {
  registry.clear();
}

/**
 * Resolve the registration name for a workflow given an explicit `name` (wins)
 * or the `run` function's `.name`. Throws a clear error when neither produces
 * a non-empty string.
 *
 * Exported because `SolidActions.registerWorkflow` needs to apply the same
 * precedence so legacy and new call sites agree on the registry key.
 */
export function resolveWorkflowName(
  explicit: string | undefined,
  runFn: (...args: never[]) => unknown,
): string {
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  const fnName = (runFn as { name?: string }).name;
  if (fnName && fnName.length > 0) {
    return fnName;
  }
  throw new Error(
    "defineWorkflow requires either an explicit name or a named run function — pass { name: '...' } or use a named function",
  );
}
