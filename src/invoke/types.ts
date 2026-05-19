export interface InvokeCtxRun {
  triggerId: string | number;
  runUuid: string;
  runSecret: string;
  workerSessionId: string;
}
export interface InvokeCtxApp {
  appVersion: string;
  appId: string;
  tenantId: string;
}
/** A connection var: opaque key + run-shared proxy (proxyToken is a bearer — treat as secret). */
export interface ConnectionVar {
  readonly key: string;
  readonly proxyUrl: string;
  readonly proxyToken: string;
}
export type VarValue = string | ConnectionVar;
export interface InvokeCtx<I = unknown> {
  input: I;
  vars: Readonly<Record<string, VarValue>>;
  run: InvokeCtxRun;
  app: InvokeCtxApp;
  api: { url: string; key: string };
  /**
   * Injected by RuntimeEnvBuilder; equals app `workflows.slug`. Absent for
   * mock/local/older deploys — the dispatch guard treats absent as legacy.
   */
  workflowSlug?: string;
  telemetry?: { enabled: boolean };
  mode: 'resident' | 'oneshot' | 'local';
  // durable primitives are attached by invoke() (Task 1.3): step, sleep, recv, send
}
export type InvokeResult<O = unknown> =
  | { status: 'completed'; output: O }
  // Task 2.7: 'child' joins sleep/recv — the SAME suspend→exit-0→re-invoke
  // machinery, signalled when a parent awaits an as-yet-unresolved child
  // workflow. No new mechanism, only a new reason literal.
  | { status: 'suspended'; reason: 'sleep' | 'recv' | 'child' }
  // Task 2.8: a SolidActionsWorkflowCancelledError surfaced from the workflow
  // body (e.g. the sleep/recv resume path detecting the run row CANCELLED).
  // Distinct from 'failed' so the one-shot path writes StatusString.CANCELLED
  // (mirroring legacy solidactions-executor.ts:606-611). No error/output
  // payload: the legacy cancelled-self branch only set
  // internalStatus.status = CANCELLED and re-threw — it carried none.
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown; phase?: 'init' | 'run' };
export interface WorkflowDescriptor<I = unknown, O = unknown> {
  run: (ctx: InvokeCtx<I> & DurablePrimitives) => Promise<O>;
  /**
   * Resolved registration name. T1 launcher rework: `defineWorkflow` (and the
   * legacy `SolidActions.registerWorkflow` shim) annotate the returned
   * descriptor with the name it was registered under, so callers (T2's
   * `startWorkflow` child-dispatch path) can read it directly off the
   * descriptor without consulting the registry. Optional on input — callers
   * may supply an explicit `name`, or rely on the `run` function's `.name`.
   */
  name?: string;
}
export interface DurablePrimitives {
  step: <T>(fn: () => T | Promise<T>, cfg?: { name?: string }) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  recv: <T = unknown>(topic?: string) => Promise<T>;
  send: (topic: string, payload: unknown) => Promise<void>;
}
