/**
 * Launcher self-invoke guard fixture (issue solidactions-app#414) —
 * registers TWO workflows and self-invokes the FIRST. Proves that when the
 * launcher's WORKFLOW_ID selects a DIFFERENT workflow than the one the
 * module already self-invoked, the launcher logs a loud error and still
 * defers — it must never start a second run.
 */
import { SolidActions } from '../../../src/solidactions';
import { defineWorkflow } from '../../../src/invoke/define-workflow';

export const wfAlpha = defineWorkflow<Record<string, never>, string>({
  name: 'mismatch-alpha',
  run: async () => {
    console.log('MISMATCH_ALPHA_RAN');
    return 'alpha';
  },
});

export const wfBeta = defineWorkflow<Record<string, never>, string>({
  name: 'mismatch-beta',
  run: async () => {
    console.log('MISMATCH_BETA_RAN');
    return 'beta';
  },
});

void SolidActions.run(wfAlpha);
