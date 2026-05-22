#!/usr/bin/env node
/**
 * T3 of the SolidActions SDK launcher rework — SDK-owned launcher.
 *
 * This file is the FIXED process entrypoint the runner will execute in
 * launcher mode (T4 wires it). It does ONE job:
 *
 *   1. Read `WORKFLOW_ENTRY_FILE` (in-sandbox target module path) and
 *      `WORKFLOW_ID` (= `$workflow->slug`) from the process env.
 *   2. Dynamic-import the target module — purely populating the registry
 *      (T1's purity guarantee: no env reads, no status writes, no exits).
 *   3. Select the target workflow from the registry:
 *        - exactly ONE registered → use it (alias case is trivially correct)
 *        - more than one         → look up by WORKFLOW_ID
 *        - zero, or no match     → synthesize a throwing descriptor and route
 *                                  the failure THROUGH `SolidActions.run()`
 *                                  so the standard one-shot lifecycle
 *                                  (status row create → error PUT → exit
 *                                  code) records it as a real run failure
 *      Parity is the load-bearing property: selection failures must not be
 *      raw `console.error`+`process.exit`; that would skip the run_status
 *      row create + error PUT and the platform would lose the run.
 *   4. `await SolidActions.run(selectedWorkflow)` — the SAME validated
 *      one-shot core that direct `SolidActions.run(wf)` uses (no engine
 *      reimplementation; `run()` itself does process.exit).
 *
 * Imports are deliberately restricted to the SDK public surface
 * (`SolidActions`, `defineWorkflow`) and the SDK-internal registry accessors
 * (`__getRegisteredWorkflow{,s}` — same `__`-prefixed convention as
 * `__shouldFailLoudOnExit` / `__entrypointGuardFlags`, available for tests
 * and the launcher but NOT re-exported via `src/index.ts`). The launcher
 * does NOT import `./invoke/invoke`, `./invoke/invoke-system-database`, or
 * `./invoke/context-adapter`: those are the engine internals, which `run()`
 * lazy-`require()`s precisely to avoid the module-load cycle documented at
 * `src/solidactions.ts:103-118` & `:837-842`. Re-introducing a static import
 * of the invoke chain here would break the cycle break.
 *
 * Misconfig (missing/empty env vars) is a deploy/dispatch CONTRACT failure
 * — there is no run row to record an error against. The launcher exits with
 * a DISTINCT exit code (2) so it shows up in runner logs as a misconfig vs.
 * a workflow failure (exit 1 from `oneShotRuntimeAdapter.exitCodeFor`).
 *
 * Path resolution: T4 will dispatch with `WORKFLOW_ENTRY_FILE` as an
 * absolute in-sandbox path (e.g. `/app/dist/simple-steps.js`). We accept
 * absolute paths as-is and resolve relative paths against `process.cwd()`
 * for resilience under local invocation (`solidactions dev`, ad-hoc tests).
 * The dispatch contract chosen here: T4 SHOULD send an absolute path —
 * relative resolution is a fallback, not a guarantee.
 */
import * as nodePath from 'node:path';

import { SolidActions } from './solidactions';
import { defineWorkflow } from './invoke/define-workflow';
import { __getRegisteredWorkflow, __getRegisteredWorkflows } from './invoke/registry';

/**
 * Exit code for misconfig (missing required env). Distinct from:
 *   - 0 (completed / suspended) — `oneShotRuntimeAdapter.exitCodeFor`
 *   - 1 (failed / cancelled)    — `oneShotRuntimeAdapter.exitCodeFor`
 *
 * Exported so tests can assert against it without hard-coding a magic number.
 */
export const LAUNCHER_MISCONFIG_EXIT_CODE = 2;

/** Deliberately unusable workflow name — the synthetic selection-failure descriptor. */
const SELECTION_FAILURE_NAME = '__launcher_selection_failure__';

/**
 * Build the synthetic throwing descriptor used to route selection failures
 * through the standard `SolidActions.run()` lifecycle.
 *
 * Defined with the unusable name `__launcher_selection_failure__`. A user
 * workflow that happens to register under this exact name would collide at
 * registry-set time, but the name is deliberately ugly enough that the risk
 * is vanishing — and the user can rename. Exported for tests.
 *
 * NOTE: registering this synthetic descriptor via `defineWorkflow()` would
 * persist it in the process-global registry and could collide with the user
 * module on a re-import. We construct a bare descriptor object instead — no
 * registration side effect — and pass it directly to `SolidActions.run()`.
 */
export function makeSelectionFailureDescriptor(message: string): ReturnType<typeof defineWorkflow> {
  // Use defineWorkflow's TYPE only via the return type — see NOTE above:
  // we deliberately do NOT call defineWorkflow() so the registry stays clean.
  return {
    name: SELECTION_FAILURE_NAME,
    // eslint-disable-next-line @typescript-eslint/require-await -- the run signature is `(ctx) => Promise<O>`; the synthetic descriptor throws synchronously, which is shape-equivalent (a rejected promise) and required by the WorkflowDescriptor contract.
    run: async () => {
      throw new Error(message);
    },
  };
}

/**
 * Selection result returned by `selectWorkflow`. The launcher always proceeds
 * to `SolidActions.run(descriptor)` — the difference is whether that descriptor
 * is the user's selected workflow or the synthetic throwing one.
 */
interface SelectionResult {
  descriptor: ReturnType<typeof defineWorkflow>;
  /** Diagnostic-only; tests use this. The launcher itself does not log it. */
  reason: 'single' | 'by-id' | 'no-registrations' | 'unknown-id';
}

/**
 * The launcher's selection algorithm — pure, testable in isolation.
 *
 * - `single`           : exactly one registered (alias case — runs regardless of `workflowId`)
 * - `by-id`            : multi-registration AND `workflowId` matched a registered name
 * - `no-registrations` : zero registered → synthetic-failure descriptor
 * - `unknown-id`       : multi-registration AND `workflowId` matched nothing → synthetic-failure
 *
 * The `__getRegisteredWorkflow{,s}` accessors are read-only — calling them
 * does NOT register or import anything.
 */
export function selectWorkflow(workflowId: string): SelectionResult {
  const all = __getRegisteredWorkflows();
  if (all.length === 1) {
    return { descriptor: all[0], reason: 'single' };
  }
  if (all.length === 0) {
    return {
      descriptor: makeSelectionFailureDescriptor(
        `Launcher: no workflows registered after importing the target module. ` +
          `Expected the module to call defineWorkflow(...) (or legacy registerWorkflow(...)). ` +
          `WORKFLOW_ID was '${workflowId}'.`,
      ),
      reason: 'no-registrations',
    };
  }
  const hit = __getRegisteredWorkflow(workflowId);
  if (hit) {
    return { descriptor: hit, reason: 'by-id' };
  }
  const candidates = all
    .map((w) => w.name ?? '<unnamed>')
    .sort()
    .join(', ');
  return {
    descriptor: makeSelectionFailureDescriptor(
      `Launcher: WORKFLOW_ID '${workflowId}' did not match any registered workflow ` +
        `after importing the target module. Registered candidates: [${candidates}].`,
    ),
    reason: 'unknown-id',
  };
}

/**
 * Resolve `WORKFLOW_ENTRY_FILE` to an absolute filesystem path. Absolute
 * paths are used as-is; relative paths are resolved against `process.cwd()`.
 * T4's dispatch contract: send an absolute in-sandbox path. Relative
 * resolution is a local-invocation convenience only.
 *
 * The compiled launcher runs in CJS (per `tsconfig.shared.json`
 * `"module": "Node16"` against a non-ESM package.json), and Node's CJS
 * dynamic `import()` resolves absolute filesystem paths directly — a
 * `file://` URL conversion is unnecessary and broke ts-jest's resolver.
 */
function resolveEntryFilePath(entryFile: string): string {
  return nodePath.isAbsolute(entryFile) ? entryFile : nodePath.resolve(process.cwd(), entryFile);
}

/**
 * Launcher entrypoint. Exported so tests can drive it directly (they set the
 * env, invoke `main()`, and observe `process.exit` via the jest interceptor).
 * When executed as the process entrypoint (via the `solidactions-launch` bin
 * or `node dist/src/launcher.js`), the `if (require.main === module)` guard
 * at the bottom of this file fires.
 */
export async function main(): Promise<void> {
  const entryFile = process.env.WORKFLOW_ENTRY_FILE;
  const workflowId = process.env.WORKFLOW_ID;

  // Misconfig is pre-run: there is no run_status row to record this against.
  // Use console.error + exit 2 (distinct from the workflow-failure exit 1).
  if (!entryFile || entryFile.length === 0) {
    console.error(
      'solidactions-launch: missing required env var WORKFLOW_ENTRY_FILE ' +
        '(in-sandbox path to the built workflow module).',
    );
    process.exit(LAUNCHER_MISCONFIG_EXIT_CODE);
    return;
  }
  if (!workflowId || workflowId.length === 0) {
    console.error('solidactions-launch: missing required env var WORKFLOW_ID (= workflow slug).');
    process.exit(LAUNCHER_MISCONFIG_EXIT_CODE);
    return;
  }

  // Dynamic-import the target. The post-codemod, pure module ONLY populates
  // the registry on import — no side effects (T1 guarantee). A pre-codemod
  // self-invoking file would fire its top-level `SolidActions.run()` here and
  // process.exit before we reach selectWorkflow — that is detected by T4's
  // deploy-time gate (rg against dist/), not by the launcher.
  await import(resolveEntryFilePath(entryFile));

  // Selection failures route through SolidActions.run(syntheticDescriptor) so
  // the failure flows through oneShotContextAdapter → status row create →
  // invoke throws → error PUT → exit code via runtime adapter — IDENTICAL
  // parity with any other workflow failure.
  const { descriptor } = selectWorkflow(workflowId);
  await SolidActions.run(descriptor);
  // SolidActions.run() calls process.exit() itself; control should not reach
  // here. The return is for type-checking only.
}

/**
 * Process-entrypoint guard. Under the SDK build (`tsc` emits CommonJS — see
 * `tsconfig.shared.json` `"module": "Node16"` against a non-ESM `package.json`),
 * `require.main === module` is the canonical "is this the entrypoint?" check.
 * When the launcher is imported as a library (e.g. by tests calling `main()`
 * directly), the guard is false and `main()` is not auto-invoked.
 */
if (require.main === module) {
  // Top-level await is not available under Node16 CJS; use .catch to surface
  // any unhandled promise rejection BEFORE the (unreachable) implicit exit.
  // Realistically `main()` never resolves cleanly — it always calls
  // process.exit() (either via the misconfig path or via SolidActions.run()).
  main().catch((err: unknown) => {
    // A throw out of main() that ISN'T routed through SolidActions.run() (e.g.
    // a dynamic-import failure before selection) is still an infra-level
    // problem with no run row to attach to — log + exit with the misconfig
    // code so it's diagnosable in runner logs.
    console.error('solidactions-launch: fatal error before run() could start:', err);
    process.exit(LAUNCHER_MISCONFIG_EXIT_CODE);
  });
}
