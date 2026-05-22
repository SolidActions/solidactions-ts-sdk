/**
 * T3 launcher selection fixture — alias case. Registers ONE workflow under
 * a name that intentionally differs from the WORKFLOW_ID a deploy might use.
 * Proves "exactly one registered → use it" runs regardless of WORKFLOW_ID.
 */
import { defineWorkflow } from '../../../src/invoke/define-workflow';

export const wf = defineWorkflow({
  name: 'launcher-alias-real-name',
  run: () => Promise.resolve('alias-output'),
});
