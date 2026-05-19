/**
 * T3 launcher parity fixture — error path. Throws from `run`.
 */
import { defineWorkflow } from '../../../src/invoke/define-workflow';

export const wf = defineWorkflow({
  name: 'launcher-throwing',
  run: () => {
    return Promise.reject(new Error('boom-launcher'));
  },
});
