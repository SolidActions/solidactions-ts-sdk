/**
 * T3 launcher parity fixture — happy-path completed workflow.
 *
 * A pure-on-import module: `defineWorkflow()` populates the registry; no
 * top-level `SolidActions.run()` / `runIfEntrypoint()`. The launcher
 * dynamic-imports this, selects the sole registered workflow (alias case),
 * and routes it through `SolidActions.run()` — the SAME entrypoint the
 * paired direct-call test uses.
 */
import { defineWorkflow } from '../../../src/invoke/define-workflow';

export const wf = defineWorkflow({
  name: 'launcher-completed',
  run: (ctx) => {
    const input = ctx.input as { n: number };
    return Promise.resolve(input.n * 2);
  },
});
