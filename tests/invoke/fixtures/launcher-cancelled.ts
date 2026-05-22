/**
 * T3 launcher parity fixture — cancellation path. The body throws
 * `SolidActionsWorkflowCancelledError` (the exact class the engine maps
 * to `{ status: 'cancelled' }`).
 */
import { defineWorkflow } from '../../../src/invoke/define-workflow';
import { SolidActionsWorkflowCancelledError } from '../../../src/error';

export const wf = defineWorkflow({
  name: 'launcher-cancelled',
  run: (ctx) => {
    return Promise.reject(new SolidActionsWorkflowCancelledError(ctx.run.runUuid));
  },
});
