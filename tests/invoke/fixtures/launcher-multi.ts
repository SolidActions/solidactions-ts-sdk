/**
 * T3 launcher selection fixture — multi-workflow module. Registers TWO
 * workflows so the launcher must look up by WORKFLOW_ID.
 */
import { defineWorkflow } from '../../../src/invoke/define-workflow';

export const first = defineWorkflow({
  name: 'launcher-multi-first',
  run: () => Promise.resolve('first-output'),
});

export const second = defineWorkflow({
  name: 'launcher-multi-second',
  run: () => Promise.resolve('second-output'),
});
