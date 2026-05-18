import type { WorkflowDescriptor } from './types';
export function defineWorkflow<I, O>(def: WorkflowDescriptor<I, O>): WorkflowDescriptor<I, O> {
  if (!def || typeof def.run !== 'function') throw new Error('defineWorkflow: { run } is required');
  return def;
}
