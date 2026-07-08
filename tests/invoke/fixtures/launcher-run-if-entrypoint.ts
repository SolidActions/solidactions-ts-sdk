/**
 * Launcher + runIfEntrypoint interaction fixture (issue solidactions-app#414,
 * Task 3). A post-codemod `defineWorkflow` module that self-invokes via the
 * CURRENT recommended pattern — `SolidActions.runIfEntrypoint(wf, callerUrl)`
 * — instead of the legacy bare `SolidActions.run(wf)` the other
 * `launcher-self-invoke-*.ts` fixtures use.
 *
 * Under the launcher, `process.argv[1]` is the test/launcher process's own
 * entrypoint, NOT this fixture file, so `isEntrypointModule` sees a mismatch
 * and the module's own `runIfEntrypoint()` call is a no-op SKIP (sets
 * `__anyRunSkippedForNonEntrypoint`, never calls `run()`). The launcher then
 * selects this module's sole registered workflow and runs it itself via
 * `SolidActions.run(descriptor)` — which is the ONLY place
 * `__anyEntrypointRunExecuted` gets set for this scenario (Task 1's fix).
 * That is what proves the fail-loud `process.on('exit')` handler stays silent
 * even though a skip was recorded.
 *
 * Fixtures compile under CJS (see tsconfig.shared.json `"module": "Node16"`
 * against a non-ESM package.json) — `import.meta.url` is unavailable. Use
 * `__filename` as the caller-identity argument instead; `isEntrypointModule`
 * accepts a bare path just as readily as a `file:` URL.
 */
import { SolidActions } from '../../../src/solidactions';
import { defineWorkflow } from '../../../src/invoke/define-workflow';

export const rieWorkflow = defineWorkflow<Record<string, never>, string>({
  name: 'rie-under-launcher',
  run: async () => {
    // eslint-disable-next-line no-console
    console.log('RIE_UNDER_LAUNCHER_RAN');
    return 'ok';
  },
});

void SolidActions.runIfEntrypoint(rieWorkflow, __filename);
