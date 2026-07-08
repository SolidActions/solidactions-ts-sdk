/**
 * Launcher self-invoke guard fixture (issue solidactions-app#414) —
 * `defineWorkflow` + a top-level `SolidActions.run()` call (the momentfactory
 * shape). Proves a self-invoking `defineWorkflow` module keeps ctx.vars
 * populated once the launcher no longer starts a second, concurrent run.
 */
import { SolidActions } from '../../../src/solidactions';
import { defineWorkflow } from '../../../src/invoke/define-workflow';

export const ctxSelfInvoked = defineWorkflow<{ probe?: string }, string>({
  name: 'ctx-self-invoked',
  run: async (ctx) => {
    // eslint-disable-next-line no-console
    console.log(`SELF_INVOKE_CTX_VARS=${JSON.stringify(Object.keys(ctx.vars).sort())}`);
    return 'ctx-done';
  },
});

void SolidActions.run(ctxSelfInvoked);
