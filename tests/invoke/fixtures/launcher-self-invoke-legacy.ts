/**
 * Launcher self-invoke guard fixture (issue solidactions-app#414) — old style:
 * `registerWorkflow` + a top-level `SolidActions.run()` call. Proves the
 * launcher defers instead of starting a SECOND run when the imported module
 * already self-invoked.
 */
import { SolidActions } from '../../../src/solidactions';

async function legacySelfInvoked(input: { probe?: string }): Promise<string> {
  // eslint-disable-next-line no-console
  console.log(`SELF_INVOKE_LEGACY_RAN input=${JSON.stringify(input)}`);
  return 'legacy-done';
}

const wf = SolidActions.registerWorkflow(legacySelfInvoked, { name: 'legacy-self-invoked' });
void SolidActions.run(wf);
