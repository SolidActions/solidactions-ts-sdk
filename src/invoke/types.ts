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
export interface ConnectionVar { readonly key: string; readonly proxyUrl: string; readonly proxyToken: string; }
export type VarValue = string | ConnectionVar;
export interface InvokeCtx<I = unknown> {
  input: I;
  vars: Readonly<Record<string, VarValue>>;
  run: InvokeCtxRun;
  app: InvokeCtxApp;
  api: { url: string; key: string };
  telemetry?: { enabled: boolean };
  mode: 'resident' | 'oneshot' | 'local';
  // durable primitives are attached by invoke() (Task 1.3): step, sleep, recv, send
}
export type InvokeResult<O = unknown> =
  | { status: 'completed'; output: O }
  | { status: 'suspended'; reason: 'sleep' | 'recv' }
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
}
export interface DurablePrimitives {
  step: <T>(fn: () => T | Promise<T>, cfg?: { name?: string }) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  recv: <T = unknown>(topic?: string) => Promise<T>;
  send: (topic: string, payload: unknown) => Promise<void>;
}
