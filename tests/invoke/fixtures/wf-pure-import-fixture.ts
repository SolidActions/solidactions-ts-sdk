/**
 * Fixture for the T1 purity test: importing this module MUST do nothing
 * beyond registering the workflow in the invoke registry — no env reads,
 * no status writes, no process.exit, no listener installs, no warnings.
 */
import { defineWorkflow } from '../../../src/invoke/define-workflow';

export const wf = defineWorkflow({
  name: 'wf-pure-fixture',
  run: () => Promise.resolve('ok'),
});
