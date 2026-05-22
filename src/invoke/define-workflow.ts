import type { WorkflowDescriptor } from './types';
import { registerWorkflowDescriptor, resolveWorkflowName } from './registry';

/**
 * Declare a SolidActions workflow.
 *
 * T1 launcher rework: in addition to validating the descriptor and returning
 * it (the pre-T1 behavior), `defineWorkflow` now populates a process-global
 * workflow registry (`src/invoke/registry.ts`). The returned descriptor is
 * annotated with the resolved registration name so T2's `startWorkflow`
 * child-dispatch can read it directly off the descriptor object.
 *
 * Name resolution precedence:
 *   1. Explicit `def.name` (wins)
 *   2. `def.run.name` (function declaration name)
 *   3. Otherwise throws — anonymous arrows must supply an explicit `name`.
 *
 * Importing a module that calls `defineWorkflow` is side-effect-free w.r.t.
 * execution: no env reads, no status writes, no `process.exit`, no warnings.
 * The ONLY observable effect is the registry entry.
 */
export function defineWorkflow<I, O>(def: WorkflowDescriptor<I, O>): WorkflowDescriptor<I, O> {
  if (!def || typeof def.run !== 'function') {
    throw new Error('defineWorkflow: { run } is required');
  }
  const resolvedName = resolveWorkflowName(def.name, def.run);
  return registerWorkflowDescriptor(def, resolvedName);
}
