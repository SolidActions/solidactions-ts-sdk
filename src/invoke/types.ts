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
/**
 * Supported connection brokers.
 *
 * `pica` is the supported proxy contract. `composio` is **deprecated** (Task 6.2):
 * Composio-backed connections will not be carried by the new `ctx.vars`
 * ConnectionVar path. The migration codemod (`src/migrate/codemod.ts`) emits a
 * deprecation report for any declared Composio connection. The literal is kept
 * here so deprecation is expressible in the type system, but it is marked
 * `@deprecated` so editors flag its use.
 */
export type ConnectionBroker =
  | 'pica'
  /** @deprecated Composio connections are no longer supported; migrate to the Pica proxy contract. */
  | 'composio';

/** A connection var: opaque key + run-shared proxy (proxyToken is a bearer — treat as secret). */
export interface ConnectionVar {
  readonly key: string;
  readonly proxyUrl: string;
  readonly proxyToken: string;
  /**
   * Originating broker, when known. Optional so existing constructions and
   * `toEqual` assertions are unaffected (the interim one-shot adapter has no
   * broker signal in its transport and omits it). `'composio'` is deprecated —
   * see {@link ConnectionBroker}.
   */
  readonly broker?: ConnectionBroker;
}

/**
 * A workspace database var: a dispatch-time-minted libSQL endpoint + token
 * (issue #1127, spec §4A). Classified deterministically from the
 * `SOLIDACTIONS__DB_KEYS` manifest — never by value-shape heuristic.
 *
 * Rehydration on replay substitutes the ENTIRE var from the live
 * adapter-supplied env (url + token + readOnly + name), not just the secret
 * fields — a deliberate divergence from `ConnectionVar`'s `proxyUrl`-preserving
 * semantics: a database's endpoint changes on restore (new physical) and its
 * `readOnly` changes on fuse transitions, so a snapshot-pinned url/readOnly
 * would be wrong on replay.
 */
export interface DatabaseVar {
  readonly name: string;
  readonly url: string;
  readonly token: string;
  readonly readOnly: boolean;
}
export type AnalyticalDatabaseBinding = string;
export type VarValue = string | ConnectionVar | DatabaseVar;
/**
 * Open augmentation hook for generated `ctx.vars` types (Task 4.1).
 *
 * A generated `.d.ts` (emitted by the SDK's vars-types generator) extends this
 * interface with their project's typed var names. Without a generated file the
 * interface is empty, so `ctx.vars` falls back to the permissive
 * `Record<string, VarValue>` — existing code continues to compile unchanged.
 *
 * Declaration-merging example (auto-generated, do not edit manually):
 *
 *   declare module '@solidactions/sdk' {
 *     interface InvokeCtxVarsAugment {
 *       MY_FLAG: string;
 *       GCAL: ConnectionVar;
 *     }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration-merging hook intentionally starts empty
export interface InvokeCtxVarsAugment {}

export interface InvokeCtx<I = unknown> {
  input: I;
  vars: Readonly<Record<string, VarValue> & InvokeCtxVarsAugment>;
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
