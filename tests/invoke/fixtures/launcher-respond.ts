/**
 * T3 launcher parity fixture — respond() bridge. Calls
 * `SolidActions.respond({...})` before returning; the launcher path must
 * issue the SAME `PUT /runs/status/<id>/webhook-output` BEFORE the
 * workflow-complete POST that direct `run()` does.
 */
import { defineWorkflow } from '../../../src/invoke/define-workflow';
import { SolidActions } from '../../../src';

export const wf = defineWorkflow({
  name: 'launcher-respond',
  run: async () => {
    await SolidActions.respond({ ok: true, value: 7 });
    return 'responded';
  },
});
