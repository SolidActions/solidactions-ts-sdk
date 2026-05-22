/**
 * T3 launcher parity fixture — suspend path. Runs a step, then sleeps;
 * the durable sleep throws SuspensionRequired in the engine, mapping to
 * `{ status: 'suspended', reason: 'sleep' }` and exit 0.
 */
import { defineWorkflow } from '../../../src/invoke/define-workflow';
import { SolidActions } from '../../../src';

export const wf = defineWorkflow({
  name: 'launcher-sleep',
  run: async () => {
    await SolidActions.runStep(() => 'step-A');
    await SolidActions.sleepms(60_000);
    return 'after-sleep';
  },
});
