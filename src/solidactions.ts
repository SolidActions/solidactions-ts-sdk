import {
  getCurrentContextStore,
  HTTPRequest,
  runWithTopContext,
  getNextWFID,
  StepStatus,
  SolidActionsContextOptions,
  functionIDGetIncrement,
  functionIDGet,
} from './context';
import {
  SolidActionsConfig,
  SolidActionsExecutor,
  SolidActionsExternalState,
  InternalWorkflowParams,
} from './solidactions-executor';
import {
  SolidActionsSpan,
  getActiveSpan,
  installTraceContextManager,
  isTraceContextWorking,
  Tracer,
} from './telemetry/traces';
import {
  GetWorkflowsInput,
  InternalWFHandle,
  isWorkflowActive,
  RetrievedHandle,
  StepInfo,
  WorkflowConfig,
  WorkflowHandle,
  WorkflowParams,
  WorkflowStatus,
} from './workflow';
import { DLogger, GlobalLogger } from './telemetry/logs';
import {
  SolidActionsError,
  SolidActionsExecutorNotInitializedError,
  SolidActionsInvalidWorkflowTransitionError,
  SolidActionsNotRegisteredError,
  SolidActionsAwaitedWorkflowCancelledError,
  SolidActionsConflictingRegistrationError,
} from './error';
import {
  getSolidActionsConfig,
  getHttpConfig,
  getRuntimeConfig,
  overwriteConfigForCloud,
  readConfigFile,
  readSolidStepsConfig,
  translateSolidActionsConfig,
  translateRuntimeConfig,
} from './config';
import {
  associateClassWithExternal,
  associateMethodWithExternal,
  ClassAuthDefaults,
  SOLIDACTIONS_AUTH,
  ExternalRegistration,
  getLifecycleListeners,
  getRegisteredOperations,
  getFunctionRegistration,
  getRegistrationsForExternal,
  insertAllMiddleware,
  MethodAuth,
  MethodRegistration,
  recordSolidActionsLaunch,
  recordSolidActionsShutdown,
  registerFunctionWrapper,
  registerLifecycleCallback,
  registerMiddlewareInstaller,
  MethodRegistrationBase,
  TypedAsyncFunction,
  UntypedAsyncFunction,
  FunctionName,
  wrapSolidActionsFunctionAndRegisterByUniqueName,
  wrapSolidActionsFunctionAndRegisterByTarget,
  wrapSolidActionsFunctionAndRegister,
  ensureSolidActionsIsLaunched,
  ConfiguredInstance,
  SolidActionsMethodMiddlewareInstaller,
  SolidActionsLifecycleCallback,
  associateParameterWithExternal,
  finalizeClassRegistrations,
  getClassRegistration,
} from './decorators';
import { defaultEnableOTLP, bootParams, sleepms } from './utils';
import { JSONValue, registerSerializationRecipe, SerializationRecipe } from './serialization';
import { SolidActionsAdminServer } from './adminserver';
import { Server } from 'http';

import { randomUUID } from 'node:crypto';

import { StepConfig } from './step';
// Task 2.3: the one-shot compat path — run() = ContextAdapter -> invoke() -> RuntimeAdapter.
//
// invoke()/contextAdapter/runtimeAdapter/HttpClient are required LAZILY inside
// run()/#reportOneShotCompletion (call-time require()) to avoid a module-load
// cycle: http_system_database -> workflow -> solidactions -> invoke ->
// invoke-system-database -> (extends) http_system_database. A STATIC import of
// the invoke chain here re-enters http_system_database before its
// HttpSystemDatabase class is defined ("Class extends value undefined", which
// breaks tests/http_client.test.ts at load instead of its documented baseline).
// The lazy-require idiom matches existing usage (src/telemetry/exporters.ts,
// traces.ts, utils.ts). runtime-scope is safe to import statically: it only
// type-imports the heavy classes, so it pulls no runtime cycle. This becomes a
// static import only once the invoke chain no longer transitively imports
// `solidactions` (e.g. `invoke-system-database`'s `http_system_database`
// dependency is made type-only / the shared HttpClient base is extracted) —
// NOT merely when the legacy executor or globalParams is deleted.
import { getCurrentPrimitives } from './invoke/runtime-scope';
import type { WorkflowDescriptor, InvokeResult, InvokeCtx } from './invoke/types';
import { Conductor } from './conductor/conductor';
import { EnqueueOptions, SOLIDACTIONS_STREAM_CLOSED_SENTINEL } from './system_database';
import { registerAuthChecker } from './authdecorators';
import assert from 'node:assert';

type AnyConstructor = new (...args: unknown[]) => object;

// Declare all the options a user can pass to the SolidActions object during launch()
export interface SolidActionsLaunchOptions {
  // For SolidActions Conductor
  conductorURL?: string;
  conductorKey?: string;
  debugMode?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PossiblyWFFunc = (...args: any[]) => Promise<unknown>;
type InvokeFunctionsAsync<T> =
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  T extends Function
    ? {
        [P in keyof T]: T[P] extends PossiblyWFFunc
          ? (...args: Parameters<T[P]>) => Promise<WorkflowHandle<Awaited<ReturnType<T[P]>>>>
          : never;
      }
    : never;

type InvokeFunctionsAsyncInst<T> = T extends ConfiguredInstance
  ? {
      [P in keyof T]: T[P] extends PossiblyWFFunc
        ? (...args: Parameters<T[P]>) => Promise<WorkflowHandle<Awaited<ReturnType<T[P]>>>>
        : never;
    }
  : never;

export interface StartWorkflowParams {
  workflowID?: string;
  queueName?: string;
  timeoutMS?: number | null;
  enqueueOptions?: EnqueueOptions;
}

export function getExecutor() {
  if (!SolidActionsExecutor.globalInstance) {
    throw new SolidActionsExecutorNotInitializedError();
  }
  return SolidActionsExecutor.globalInstance;
}

export function runInternalStep<T>(
  callback: () => Promise<T>,
  funcName: string,
  childWFID?: string,
  assignedFuncID?: number,
): Promise<T> {
  if (SolidActions.isWithinWorkflow()) {
    if (SolidActions.isInStep()) {
      // OK to use directly
      return callback();
    } else if (SolidActions.isInWorkflow()) {
      return SolidActionsExecutor.globalInstance!.runInternalStep<T>(
        callback,
        funcName,
        SolidActions.workflowID!,
        assignedFuncID ?? functionIDGetIncrement(),
        childWFID,
      );
    } else {
      throw new SolidActionsInvalidWorkflowTransitionError(
        `Invalid call to \`${funcName}\` inside a \`transaction\` or \`procedure\``,
      );
    }
  }
  return callback();
}

export class SolidActions {
  ///////
  // Lifecycle
  ///////
  static adminServer: Server | undefined = undefined;
  static conductor: Conductor | undefined = undefined;

  /**
   * Set configuration of `SolidActions` prior to `launch`
   * @param config - configuration of services needed by SolidActions
   */
  static setConfig(config: SolidActionsConfig) {
    assert(!SolidActions.isInitialized(), 'Cannot call SolidActions.setConfig after SolidActions.launch');
    SolidActions.#solidActionsConfig = config;
  }

  /**
   * Check if SolidActions has been `launch`ed (and not `shutdown`)
   * @returns `true` if SolidActions has been launched, or `false` otherwise
   */
  static isInitialized(): boolean {
    return !!SolidActionsExecutor.globalInstance?.initialized;
  }

  /**
   * Launch SolidActions, starting recovery and request handling
   * @param options - Launch options for connecting to SolidActions Conductor
   */
  static async launch(options?: SolidActionsLaunchOptions): Promise<void> {
    const debugMode = options?.debugMode ?? process.env.SOLIDACTIONS_DEBUG_WORKFLOW_ID !== undefined;
    const configFile = await readConfigFile();

    // If no setConfig() was called, try to auto-configure from solidsteps.yaml + env vars
    if (!SolidActions.#solidActionsConfig) {
      const solidStepsConfig = await readSolidStepsConfig();
      if (solidStepsConfig.project || process.env.SOLIDACTIONS_API_URL) {
        // Auto-configure: use project name from solidsteps.yaml, API config from env vars
        try {
          const httpConfig = getHttpConfig(configFile);
          SolidActions.#solidActionsConfig = {
            name: solidStepsConfig.project || configFile.name,
            api: {
              url: httpConfig.apiUrl,
              key: httpConfig.apiKey,
              timeout: httpConfig.timeout,
              maxRetries: httpConfig.maxRetries,
            },
          };
        } catch {
          // If we can't get HTTP config, fall back to normal config file handling
        }
      }
    }

    let internalConfig = SolidActions.#solidActionsConfig
      ? translateSolidActionsConfig(SolidActions.#solidActionsConfig, debugMode)
      : getSolidActionsConfig(configFile);
    let runtimeConfig = SolidActions.#solidActionsConfig
      ? translateRuntimeConfig(SolidActions.#solidActionsConfig)
      : getRuntimeConfig(configFile);

    if (process.env.SOLIDACTIONS__CLOUD === 'true' || process.env.SOLIDACTIONS__CLOUD === 'true') {
      [internalConfig, runtimeConfig] = overwriteConfigForCloud(internalConfig, runtimeConfig, configFile);
    }

    bootParams.enableOTLP = SolidActions.#solidActionsConfig?.enableOTLP ?? defaultEnableOTLP();

    if (!isTraceContextWorking()) installTraceContextManager(internalConfig.name);

    // Do nothing if SolidActions is already initialized
    if (SolidActions.isInitialized()) {
      return;
    }

    finalizeClassRegistrations();
    insertAllMiddleware();

    // Globally set the application version and executor ID.
    // In SolidActions Cloud, instead use the value supplied through environment variables.
    if (process.env.SOLIDACTIONS__CLOUD !== 'true') {
      if (SolidActions.#solidActionsConfig?.applicationVersion) {
        bootParams.appVersion = SolidActions.#solidActionsConfig.applicationVersion;
      } else if (SolidActions.#solidActionsConfig?.enablePatching) {
        bootParams.appVersion = 'PATCHING_ENABLED';
      }
      if (SolidActions.#solidActionsConfig?.executorID) {
        bootParams.executorID = SolidActions.#solidActionsConfig.executorID;
      }
    }
    if (options?.conductorKey) {
      // Always use a generated executor ID in Conductor.
      bootParams.executorID = randomUUID();
    }

    SolidActionsExecutor.globalInstance = new SolidActionsExecutor(internalConfig, { debugMode });

    recordSolidActionsLaunch();

    const executor: SolidActionsExecutor = SolidActionsExecutor.globalInstance;
    await executor.init();

    const debugWorkflowId = process.env.SOLIDACTIONS_DEBUG_WORKFLOW_ID;
    if (debugWorkflowId) {
      SolidActions.logger.info(`Debugging workflow "${debugWorkflowId}"`);
      const handle = await executor.executeWorkflowId(debugWorkflowId);
      await handle.getResult();
      SolidActions.logger.info(`Workflow Debugging complete. Exiting process.`);
      await executor.destroy();
      process.exit(0);
      return; // return for cases where process.exit is mocked
    }

    await SolidActionsExecutor.globalInstance.initEventReceivers();

    if (options?.conductorKey) {
      if (!options.conductorURL) {
        const solidActionsDomain = process.env.SOLIDACTIONS_DOMAIN || 'cloud.dbos.dev';
        options.conductorURL = `wss://${solidActionsDomain}/conductor/v1alpha1`;
      }
      SolidActions.conductor = new Conductor(
        SolidActionsExecutor.globalInstance,
        options.conductorKey,
        options.conductorURL,
      );
      SolidActions.conductor.dispatchLoop();
    }

    // Start the SolidActions admin server
    const logger = SolidActions.logger;
    if (runtimeConfig.runAdminServer) {
      const adminApp = SolidActionsAdminServer.setupAdminApp(executor);
      try {
        await SolidActionsAdminServer.checkPortAvailabilityIPv4Ipv6(runtimeConfig.admin_port, logger as GlobalLogger);
        // Wrap the listen call in a promise to properly catch errors
        SolidActions.adminServer = await new Promise((resolve, reject) => {
          const server = adminApp.listen(runtimeConfig?.admin_port, () => {
            SolidActions.logger.debug(
              `SolidActions Admin Server is running at http://localhost:${runtimeConfig?.admin_port}`,
            );
            resolve(server);
          });
          server.on('error', (err) => {
            reject(err);
          });
        });
      } catch (e) {
        logger.warn(`Unable to start SolidActions admin server on port ${runtimeConfig.admin_port}`);
      }
    }
  }

  /**
   * Logs all workflows that can be invoked externally.
   */
  static logRegisteredEndpoints(): void {
    if (!SolidActionsExecutor.globalInstance) return;
    for (const lcl of getLifecycleListeners()) {
      lcl.logRegisteredEndpoints?.();
    }
  }

  /**
   * Shut down SolidActions processing:
   *   Stops receiving external workflow requests
   *   Disconnects from administration / Conductor
   *   Stops workflow processing and disconnects from databases
   */
  static async shutdown() {
    // Stop the admin server
    if (SolidActions.adminServer) {
      SolidActions.adminServer.close();
      SolidActions.adminServer = undefined;
    }

    // Stop the conductor
    if (SolidActions.conductor) {
      SolidActions.conductor.stop();
      while (!SolidActions.conductor.isClosed) {
        await sleepms(500);
      }
      SolidActions.conductor = undefined;
    }

    // Stop the executor
    if (SolidActionsExecutor.globalInstance) {
      await SolidActionsExecutor.globalInstance.deactivateEventReceivers();
      await SolidActionsExecutor.globalInstance.destroy();
      SolidActionsExecutor.globalInstance = undefined;
    }

    // Reset the global app version and executor ID
    bootParams.appVersion = process.env.SOLIDACTIONS__APPVERSION || '';
    bootParams.wasComputed = false;
    bootParams.appID = process.env.SOLIDACTIONS__APPID || '';
    bootParams.executorID = process.env.SOLIDACTIONS_RUN_ID || 'local';

    recordSolidActionsShutdown();
  }

  //////
  // Convenience APIs for SolidSteps workflows
  //////

  /**
   * Get the workflow input from WORKFLOW_INPUT environment variable.
   * This is set by the SolidSteps runner from the webhook payload.
   * @returns Parsed input or empty object if not set
   */
  static getInput<T = Record<string, unknown>>(): T {
    /* boot-only */ // legacy runner transport (WORKFLOW_INPUT env); invoke() takes input from ctx.input
    const raw = process.env.WORKFLOW_INPUT;
    if (!raw) {
      return {} as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return {} as T;
    }
  }

  /**
   * Get workflow input, with async fallback to WORKFLOW_INPUT_URL.
   *
   * Resolution order:
   * 1. WORKFLOW_INPUT env var (parsed as JSON)
   * 2. WORKFLOW_INPUT_URL env var (fetched via HTTP GET with Bearer auth)
   * 3. Empty object
   *
   * The URL fallback supports large webhook payloads that exceed
   * environment variable size limits. The endpoint is expected to
   * return raw JSON (the trigger_input array).
   *
   * @returns Parsed input or empty object if not available
   */
  static async getInputAsync<T = Record<string, unknown>>(): Promise<T> {
    /* boot-only */ // legacy runner transport (WORKFLOW_INPUT / WORKFLOW_INPUT_URL env); invoke() takes input from ctx.input
    // Try WORKFLOW_INPUT first (same as getInput)
    const raw = process.env.WORKFLOW_INPUT;
    if (raw) {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return {} as T;
      }
    }

    // Fallback: fetch from WORKFLOW_INPUT_URL
    const url = process.env.WORKFLOW_INPUT_URL;
    if (!url) {
      return {} as T;
    }

    const apiKey = process.env.SOLIDACTIONS_API_KEY;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch workflow input from WORKFLOW_INPUT_URL: ${response.status} ${response.statusText}`,
      );
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return {} as T;
    }
  }

  /**
   * Run a workflow as a one-shot process.
   *
   * Task 2.3 — this is now the one-shot compat layer. It no longer drives the
   * legacy launch()/startWorkflow()/getResult()/shutdown() lifecycle; instead it
   * is the literal composition the architecture intends:
   *
   *   oneShotContextAdapter(process.env)  →  invoke(descriptor, ctx)
   *     →  reproduce the legacy completion POST from the InvokeResult
   *     →  process.exit(oneShotRuntimeAdapter.exitCodeFor(result))
   *
   * invoke() is fully global-free (it runs on InvokeSystemDatabase under an ALS
   * scope; identity comes strictly from `ctx`), so the workflow EXECUTION path
   * is fully explicit here. Task 2.4a deleted `globalParams`; the legacy
   * launch/shutdown `bootParams` identity remains for the legacy executor only
   * (boot-only, never the workflow path). The run-row / registerWorkflow
   * lifecycle seams are retired separately in Task 2.4c; see the
   * `// Task 2.4c:` seams.
   *
   * `workflow` may be either a {@link WorkflowDescriptor} (`{ run }`), the
   * callable wrapper returned by the (now deprecated) `registerWorkflow` shim,
   * or a bare `(input) => Promise<output>` function. All three are normalized to
   * a descriptor whose `run(ctx)` invokes the user function with `ctx.input`.
   *
   * The `SOLIDACTIONS_DEBUG_WORKFLOW_ID` debug-launch flow stays legacy-only:
   * when that env var is set we defer to the legacy launch() path (which owns
   * debug replay) instead of the one-shot path.
   *
   * @example
   * ```typescript
   * const wf = SolidActions.registerWorkflow(myWorkflow);
   * await SolidActions.run(wf);
   * ```
   */
  static async run<T, R>(
    workflow: WorkflowDescriptor<T, R> | ((input: T) => R | Promise<R>),
    options?: {
      input?: T; // Pre-parsed input (overrides WORKFLOW_INPUT)
      workflowID?: string; // Custom workflow ID (reserved; one-shot id comes from SOLIDACTIONS_RUN_ID)
    },
  ): Promise<void> {
    // SOLIDACTIONS_DEBUG_WORKFLOW_ID replay stays on the legacy lifecycle — that
    // path owns recorded-result comparison and is not part of one-shot run().
    if (process.env.SOLIDACTIONS_DEBUG_WORKFLOW_ID) {
      try {
        await SolidActions.launch(); // legacy launch() handles the debug replay + process.exit(0)
        await SolidActions.shutdown();
        process.exit(0);
      } catch (error) {
        console.error('Workflow failed:', error);
        try {
          await SolidActions.shutdown();
        } catch {
          // Ignore shutdown errors
        }
        process.exit(1);
      }
      return;
    }

    // --- one-shot path: ContextAdapter -> invoke() -> RuntimeAdapter ---------
    // Lazy require(): see the import-block comment — a STATIC import of the
    // invoke chain creates a module-load cycle through http_system_database
    // ("Class extends value undefined"). Deferring to call-time breaks the
    // cycle. require() (not dynamic import()) matches the codebase's existing
    // lazy-load idiom (src/telemetry/exporters.ts, traces.ts, utils.ts) and
    // resolves correctly under ts-jest's extensionless resolution.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy require to break the module-load cycle (see import-block comment)
    const { invoke } = require('./invoke/invoke') as typeof import('./invoke/invoke');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy require (see above)
    const { oneShotContextAdapter } = require('./invoke/context-adapter') as typeof import('./invoke/context-adapter');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy require (see above)
    const { oneShotRuntimeAdapter } = require('./invoke/runtime-adapter') as typeof import('./invoke/runtime-adapter');

    const descriptor = SolidActions.#toWorkflowDescriptor<T, R>(workflow, options?.input);
    const ctx = oneShotContextAdapter(process.env as Record<string, string>);

    // ctx.input is `unknown` until the engine parses WORKFLOW_INPUT; the workflow
    // descriptor re-applies <T>, so this widening cast is sound.
    const result = await invoke<T, R>(descriptor, ctx as unknown as InvokeCtx<T>);

    // Reproduce the legacy backend completion signal from the InvokeResult.
    //
    // Legacy run() POSTed completion indirectly: the executor called
    // systemDatabase.recordWorkflowOutput/Error (PUT .../output|/error, which
    // mutates a status row the executor had already created) AND
    // systemDatabase.reportWorkflowComplete (POST .../workflow-complete — a
    // fire-and-forget infra signal whose errors are swallowed).
    //
    // The invoke() engine (InvokeSystemDatabase) deliberately does NOT create
    // that status row (see invoke.ts header), so the row-mutating PUTs have no
    // row to update on the one-shot path. The faithful, row-independent
    // completion signal is reportWorkflowComplete; we reproduce exactly that
    // POST here from the InvokeResult. Recreating the legacy status-row
    // lifecycle is Task 2.4b convergence work, not 2.3/2.4a.
    await SolidActions.#reportOneShotCompletion(ctx.api, ctx.run.runUuid, result);

    process.exit(oneShotRuntimeAdapter.exitCodeFor(result));
  }

  /**
   * Normalize the accepted `run()` workflow argument into a WorkflowDescriptor.
   *
   * - `{ run }` descriptor → used directly.
   * - legacy `registerWorkflow` wrapper → its registration's `origFunction`
   *   (the user-provided function) is recovered and wrapped so the durable
   *   primitives flow through invoke()'s ALS scope rather than the legacy
   *   executor. Task 2.4c: once the legacy wrapper is retired this recovery
   *   collapses to a plain descriptor.
   * - bare function → wrapped directly.
   *
   * The `presetInput` (run()'s options.input) overrides ctx.input when given.
   */
  static #toWorkflowDescriptor<T, R>(
    workflow: WorkflowDescriptor<T, R> | ((input: T) => R | Promise<R>),
    presetInput?: T,
  ): WorkflowDescriptor<T, R> {
    if (workflow && typeof (workflow as WorkflowDescriptor<T, R>).run === 'function') {
      const inner = workflow as WorkflowDescriptor<T, R>;
      if (presetInput === undefined) {
        return inner;
      }
      return {
        run: (ctx) => inner.run({ ...ctx, input: presetInput } as typeof ctx),
      };
    }

    // Recover the user function from a legacy registerWorkflow wrapper, if any.
    // Task 2.4c: legacy wrapper/registration coupling — converges when the
    // legacy executor path is deleted.
    const fn = workflow as (input: T) => R | Promise<R>;
    const reg = getFunctionRegistration(fn);
    const userFn = (reg?.origFunction as ((input: T) => R | Promise<R>) | undefined) ?? fn;

    return {
      run: (ctx) => Promise.resolve(userFn(presetInput !== undefined ? presetInput : ctx.input)),
    };
  }

  /**
   * Reproduce the legacy `reportWorkflowComplete` POST from an InvokeResult.
   *
   * Mirrors HttpSystemDatabase.reportWorkflowComplete:
   *   POST /runs/status/<id>/workflow-complete { status, output?, error? }
   * with `status: 'completed' | 'failed'` and errors swallowed (the infra
   * webhook/reaper is the fallback). Suspension is terminal-neutral for the
   * one-shot process (exit 0) and posts nothing here — the sleep/recv schedule
   * was already POSTed by InvokeSystemDatabase before it threw.
   */
  static async #reportOneShotCompletion(
    api: { url: string; key: string },
    workflowID: string,
    result: InvokeResult,
  ): Promise<void> {
    if (result.status === 'suspended') {
      return;
    }
    // Lazy require() (see import-block comment): http_client is pulled by the
    // invoke chain; a static import here would re-enter the module-load cycle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy require (see import-block comment)
    const { HttpClient } = require('./http_client') as typeof import('./http_client');
    const client = new HttpClient({ baseUrl: api.url, apiKey: api.key }, SolidActions.logger as GlobalLogger);
    try {
      if (result.status === 'completed') {
        await client.post(`/runs/status/${encodeURIComponent(workflowID)}/workflow-complete`, {
          status: 'completed',
          output: result.output,
        });
      } else {
        const err = result.error;
        const message = err instanceof Error ? err.message : String(err);
        await client.post(`/runs/status/${encodeURIComponent(workflowID)}/workflow-complete`, {
          status: 'failed',
          error: message,
        });
      }
    } catch (err) {
      // Non-fatal: matches legacy reportWorkflowComplete (infra signal fallback).
      const errMsg = err instanceof Error ? err.message : String(err);
      (SolidActions.logger as GlobalLogger).warn(
        `Failed to report one-shot workflow completion for ${workflowID} (${result.status}): ${errMsg}`,
      );
    }
  }

  /**
   * Interface for signal URLs returned by getSignalUrls()
   */
  static getSignalUrls(topic?: string): {
    base: string;
    approve: string;
    reject: string;
    custom: (action: string) => string;
  } {
    /* boot-only */ // legacy runner transport (SOLIDACTIONS_API_URL / APP_URL env); the invoke() path derives URLs from ctx.api
    const baseApiUrl =
      process.env.SOLIDACTIONS_API_URL?.replace('/api/internal', '') ||
      process.env.APP_URL ||
      'http://localhost:8000';

    const workflowId = SolidActions.workflowID;
    if (!workflowId) {
      throw new SolidActionsError('getSignalUrls() must be called from within a workflow');
    }

    const topicParam = topic ? `&topic=${encodeURIComponent(topic)}` : '';
    const base = `${baseApiUrl}/api/signal/${workflowId}`;

    return {
      base,
      approve: `${base}?choice=approve${topicParam}`,
      reject: `${base}?choice=reject${topicParam}`,
      custom: (action: string) => `${base}?choice=${encodeURIComponent(action)}${topicParam}`,
    };
  }

  /** Stop listening for external events (for testing) */
  static async deactivateEventReceivers() {
    return SolidActionsExecutor.globalInstance?.deactivateEventReceivers();
  }

  /** Start listening for external events (for testing) */
  static async initEventReceivers() {
    return SolidActionsExecutor.globalInstance?.initEventReceivers();
  }

  // Global SolidActions executor instance
  static get #executor() {
    return getExecutor();
  }

  //////
  // Globals
  //////
  static #solidActionsConfig?: SolidActionsConfig;

  //////
  // Context
  //////
  /** Get the current SolidActions Logger, appropriate to the current context */
  static get logger(): DLogger {
    const lctx = getCurrentContextStore();
    if (lctx?.logger) return lctx.logger;
    const executor = SolidActionsExecutor.globalInstance;
    if (executor) return executor.logger;
    return new GlobalLogger();
  }

  /** Get the current SolidActions Tracer, for starting spans */
  static get tracer(): Tracer | undefined {
    const executor = SolidActionsExecutor.globalInstance;
    if (executor) return executor.tracer;
  }

  /** Get the current SolidActions tracing span, appropriate to the current context */
  static get span(): SolidActionsSpan | undefined {
    return getActiveSpan();
  }

  /**
   * Get the current request object (such as an HTTP request)
   * This is intended for use in event libraries that know the type of the current request,
   *  and set it using `withTracedContext` or `runWithContext`
   */
  static requestObject(): object | undefined {
    return getCurrentContextStore()?.request;
  }

  /** Get the current HTTP request (within `@SolidActions.getApi` et al) */
  static getRequest(): HTTPRequest | undefined {
    return this.requestObject() as HTTPRequest | undefined;
  }

  /** Get the current HTTP request (within `@SolidActions.getApi` et al) */
  static get request(): HTTPRequest {
    const r = SolidActions.getRequest();
    if (!r) throw new SolidActionsError('`SolidActions.request` accessed from outside of HTTP requests');
    return r;
  }

  /** Get the current application version */
  static get applicationVersion(): string {
    return bootParams.appVersion;
  }

  /** Get the current workflow ID */
  static get workflowID(): string | undefined {
    return getCurrentContextStore()?.workflowId;
  }

  /**
   * Get the current run ID (alias for workflowID).
   * This is the unique identifier assigned by SolidSteps at trigger time.
   */
  static get runID(): string | undefined {
    return SolidActions.workflowID;
  }

  /** Get the current step number, within the current workflow */
  static get stepID(): number | undefined {
    if (SolidActions.isInStep()) {
      return getCurrentContextStore()?.curStepFunctionId;
    } else if (SolidActions.isInTransaction()) {
      return getCurrentContextStore()?.curTxFunctionId;
    } else {
      return undefined;
    }
  }

  static get stepStatus(): StepStatus | undefined {
    return getCurrentContextStore()?.stepStatus;
  }

  /** Get the current authenticated user */
  static get authenticatedUser(): string {
    return getCurrentContextStore()?.authenticatedUser ?? '';
  }
  /** Get the roles granted to the current authenticated user */
  static get authenticatedRoles(): string[] {
    return getCurrentContextStore()?.authenticatedRoles ?? [];
  }
  /** Get the role assumed by the current user giving authorization to execute the current function */
  static get assumedRole(): string {
    return getCurrentContextStore()?.assumedRole ?? '';
  }

  /** @returns true if called from within a transaction, false otherwise */
  static isInTransaction(): boolean {
    return getCurrentContextStore()?.curTxFunctionId !== undefined;
  }

  /** @returns true if called from within a step, false otherwise */
  static isInStep(): boolean {
    return getCurrentContextStore()?.curStepFunctionId !== undefined;
  }

  /**
   * @returns true if called from within a workflow
   *  (regardless of whether the workflow is currently executing a step,
   *   transaction, or procedure), false otherwise
   */
  static isWithinWorkflow(): boolean {
    return getCurrentContextStore()?.workflowId !== undefined;
  }

  /**
   * @returns true if called from within a workflow that is not currently executing
   *  a step, transaction, or procedure, or false otherwise
   */
  static isInWorkflow(): boolean {
    return SolidActions.isWithinWorkflow() && !SolidActions.isInTransaction() && !SolidActions.isInStep();
  }

  //////
  // Access to system DB, for event receivers etc.
  //////
  /**
   * Get a state item from the system database, which provides a key/value store interface for event dispatchers.
   *   The full key for the database state should include the service, function, and item.
   *   Values are versioned.  A version can either be a sequence number (long integer), or a time (high precision floating point).
   *       If versions are in use, any upsert is discarded if the version field is less than what is already stored.
   *
   * Examples of state that could be kept:
   *   Offsets into kafka topics, per topic partition
   *   Last time for which a scheduling service completed schedule dispatch
   *
   * @param service - should be unique to the event receiver keeping state, to separate from others
   * @param workflowFnName - function name; should be the fully qualified / unique function name dispatched
   * @param key - The subitem kept by event receiver service for the function, allowing multiple values to be stored per function
   * @returns The latest system database state for the specified service+workflow+item
   */
  static async getEventDispatchState(
    svc: string,
    wfn: string,
    key: string,
  ): Promise<SolidActionsExternalState | undefined> {
    ensureSolidActionsIsLaunched('getEventDispatchState');
    return await SolidActions.#executor.getEventDispatchState(svc, wfn, key);
  }
  /**
   * Set a state item into the system database, which provides a key/value store interface for event dispatchers.
   *   The full key for the database state should include the service, function, and item; these fields are part of `state`.
   *   Values are versioned.  A version can either be a sequence number (long integer), or a time (high precision floating point).
   *     If versions are in use, any upsert is discarded if the version field is less than what is already stored.
   *
   * @param state - the service, workflow, item, version, and value to write to the database
   * @returns The upsert returns the current record, which may be useful if it is more recent than the `state` provided.
   */
  static async upsertEventDispatchState(state: SolidActionsExternalState): Promise<SolidActionsExternalState> {
    ensureSolidActionsIsLaunched('upsertEventDispatchState');
    return await SolidActions.#executor.upsertEventDispatchState(state);
  }

  //////
  // Workflow and other operations
  //////

  /**
   * Get the workflow status given a workflow ID
   * @param workflowID - ID of the workflow
   * @returns status of the workflow as `WorkflowStatus`, or `null` if there is no workflow with `workflowID`
   */
  static getWorkflowStatus(workflowID: string): Promise<WorkflowStatus | null> {
    ensureSolidActionsIsLaunched('getWorkflowStatus');
    if (SolidActions.isWithinWorkflow()) {
      if (SolidActions.isInStep()) {
        // OK to use directly
        return SolidActions.#executor.getWorkflowStatus(workflowID);
      } else if (SolidActions.isInWorkflow()) {
        return SolidActions.#executor.getWorkflowStatus(workflowID, SolidActions.workflowID, functionIDGetIncrement());
      } else {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `getWorkflowStatus` inside a `transaction` or `procedure`',
        );
      }
    }
    return SolidActions.#executor.getWorkflowStatus(workflowID);
  }

  /**
   * Get the workflow result, given a workflow ID
   * @param workflowID - ID of the workflow
   * @param timeoutSeconds - Maximum time to wait for result
   * @returns The return value of the workflow, or throws the exception thrown by the workflow, or `null` if times out
   */
  static async getResult<T>(workflowID: string, timeoutSeconds?: number): Promise<T | null> {
    ensureSolidActionsIsLaunched('getResult');
    let timerFuncID: number | undefined = undefined;
    if (SolidActions.isWithinWorkflow() && timeoutSeconds !== undefined) {
      timerFuncID = functionIDGetIncrement();
    }
    return await SolidActions.getResultInternal(workflowID, timeoutSeconds, timerFuncID, undefined);
  }

  static async getResultInternal<T>(
    workflowID: string,
    timeoutSeconds?: number,
    timerFuncID?: number,
    assignedFuncID?: number,
  ): Promise<T | null> {
    return await runInternalStep(
      async () => {
        const rres = await SolidActionsExecutor.globalInstance!.systemDatabase.awaitWorkflowResult(
          workflowID,
          timeoutSeconds,
          SolidActions.workflowID,
          timerFuncID,
        );
        if (!rres) return null;
        if (rres?.cancelled) {
          throw new SolidActionsAwaitedWorkflowCancelledError(workflowID);
        }
        return SolidActionsExecutor.reviveResultOrError<T>(rres, SolidActions.#executor.serializer);
      },
      'SolidActions.getResult',
      workflowID,
      assignedFuncID,
    );
  }

  /**
   * Create a workflow handle with a given workflow ID.
   * This call always returns a handle, even if the workflow does not exist.
   * The resulting handle will check the database to provide any workflow information.
   * @param workflowID - ID of the workflow
   * @returns `WorkflowHandle` that can be used to poll for the status or result of any workflow with `workflowID`
   */
  static retrieveWorkflow<T = unknown>(workflowID: string): WorkflowHandle<Awaited<T>> {
    ensureSolidActionsIsLaunched('retrieveWorkflow');
    if (SolidActions.isWithinWorkflow()) {
      if (!SolidActions.isInWorkflow()) {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `retrieveWorkflow` inside a `transaction` or `step`',
        );
      }
      return new RetrievedHandle(SolidActionsExecutor.globalInstance!.systemDatabase, workflowID);
    }
    return SolidActions.#executor.retrieveWorkflow(workflowID);
  }

  /**
   * Query the system database for all workflows matching the provided predicate
   * @param input - `GetWorkflowsInput` predicate for filtering returned workflows
   * @returns `WorkflowStatus` array containing details of the matching workflows
   */
  static async listWorkflows(input: GetWorkflowsInput): Promise<WorkflowStatus[]> {
    ensureSolidActionsIsLaunched('listWorkflows');
    return await runInternalStep(async () => {
      return await SolidActions.#executor.listWorkflows(input);
    }, 'SolidActions.listWorkflows');
  }

  /**
   * Retrieve the steps of a workflow
   * @param workflowID - ID of the workflow
   * @returns `StepInfo` array listing the executed steps of the workflow. If the workflow is not found, `undefined` is returned.
   */
  static async listWorkflowSteps(workflowID: string): Promise<StepInfo[] | undefined> {
    ensureSolidActionsIsLaunched('listWorkflowSteps');
    return await runInternalStep(async () => {
      return await SolidActions.#executor.listWorkflowSteps(workflowID);
    }, 'SolidActions.listWorkflowSteps');
  }

  /**
   * Cancel a workflow given its ID.
   * If the workflow is currently running, `SolidActionsWorkflowCancelledError` will be
   *   thrown from its next SolidActions call.
   * @param workflowID - ID of the workflow
   */
  static async cancelWorkflow(workflowID: string): Promise<void> {
    ensureSolidActionsIsLaunched('cancelWorkflow');
    return await runInternalStep(async () => {
      return await SolidActions.#executor.cancelWorkflow(workflowID);
    }, 'SolidActions.cancelWorkflow');
  }

  /**
   * Resume a workflow given its ID.
   * @param workflowID - ID of the workflow
   */
  static async resumeWorkflow<T>(workflowID: string): Promise<WorkflowHandle<Awaited<T>>> {
    ensureSolidActionsIsLaunched('resumeWorkflow');
    await runInternalStep(async () => {
      return await SolidActions.#executor.resumeWorkflow(workflowID);
    }, 'SolidActions.resumeWorkflow');
    return this.retrieveWorkflow(workflowID);
  }

  /**
   * Fork a workflow given its ID.
   * @param workflowID - ID of the workflow
   * @param startStep - Step ID to start the forked workflow from
   * @param applicationVersion - Version of the application to use for the forked workflow
   * @returns A handle to the forked workflow
   * @throws SolidActionsInvalidStepIDError if the `startStep` is greater than the maximum step ID of the workflow
   */
  static async forkWorkflow<T>(
    workflowID: string,
    startStep: number,
    options?: { newWorkflowID?: string; applicationVersion?: string; timeoutMS?: number },
  ): Promise<WorkflowHandle<Awaited<T>>> {
    ensureSolidActionsIsLaunched('forkWorkflow');
    const forkedID = await runInternalStep(async () => {
      return await SolidActions.#executor.forkWorkflow(workflowID, startStep, options);
    }, 'SolidActions.forkWorkflow');

    return this.retrieveWorkflow(forkedID);
  }

  /**
   * Sleep for the specified amount of time.
   * If called from within a workflow, the sleep is "durable",
   *   meaning that the workflow will sleep until the wakeup time
   *   (calculated by adding `durationMS` to the original invocation time),
   *   regardless of workflow recovery.
   * @param durationMS - Length of sleep, in milliseconds.
   */
  static async sleepms(durationMS: number): Promise<void> {
    // Task 2.3: when a legacy-registered workflow body runs under the one-shot
    // run() path it executes inside invoke()'s ALS scope (not the legacy
    // executor). Delegate the durable sleep to invoke()'s OWN sleep primitive
    // (single source of truth) — it posts the sleep schedule and throws
    // SuspensionRequired (→ run() maps to exit 0 + a scheduled sleep).
    const invokePrimitives = getCurrentPrimitives();
    if (invokePrimitives) {
      if (durationMS <= 0) {
        return;
      }
      return await invokePrimitives.sleep(durationMS);
    }
    if (SolidActions.isWithinWorkflow() && !SolidActions.isInStep()) {
      if (SolidActions.isInTransaction()) {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `SolidActions.sleep` inside a `transaction`',
        );
      }
      const functionID = functionIDGetIncrement();
      if (durationMS <= 0) {
        return;
      }
      return await SolidActionsExecutor.globalInstance!.systemDatabase.durableSleepms(
        SolidActions.workflowID!,
        functionID,
        durationMS,
      );
    }
    await sleepms(durationMS);
  }
  /** @see sleepms */
  static async sleepSeconds(durationSec: number): Promise<void> {
    return SolidActions.sleepms(durationSec * 1000);
  }
  /** @see sleepms */
  static async sleep(durationMS: number): Promise<void> {
    return SolidActions.sleepms(durationMS);
  }

  /**
   * Get the current time in milliseconds, similar to `Date.now()`.
   * This function is deterministic and can be used within workflows.
   */
  static async now(): Promise<number> {
    if (SolidActions.isInWorkflow()) {
      return runInternalStep(async () => Promise.resolve(Date.now()), 'SolidActions.now');
    }
    return Date.now();
  }

  /**
   * Generate a random (v4) UUUID, similar to `node:crypto.randomUUID`.
   * This function is deterministic and can be used within workflows.
   */
  static async randomUUID(): Promise<string> {
    if (SolidActions.isInWorkflow()) {
      return runInternalStep(async () => Promise.resolve(randomUUID()), 'SolidActions.randomUUID');
    }
    return randomUUID();
  }

  /**
   * Use the provided `workflowID` as the identifier for first workflow started
   *   within the `callback` function.
   * @param workflowID - ID to assign to the first workflow started
   * @param callback - Function to run, which would start a workflow
   * @returns - Return value from `callback`
   */
  static async withNextWorkflowID<R>(workflowID: string, callback: () => Promise<R>): Promise<R> {
    ensureSolidActionsIsLaunched('workflows');
    return SolidActions.#withTopContext({ idAssignedForNextWorkflow: workflowID }, callback);
  }

  /**
   * Use the provided `authedUser` and `authedRoles` as the authenticated user for
   *   any security checks or calls to `SolidActions.authenticatedUser`
   *   or `SolidActions.authenticatedRoles` placed within the `callback` function.
   * @param authedUser - Authenticated user
   * @param authedRoles - Authenticated roles
   * @param callback - Function to run with authentication context in place
   * @returns - Return value from `callback`
   */
  static async withAuthedContext<R>(authedUser: string, authedRoles: string[], callback: () => Promise<R>): Promise<R> {
    ensureSolidActionsIsLaunched('auth');
    return SolidActions.#withTopContext(
      {
        authenticatedUser: authedUser,
        authenticatedRoles: authedRoles,
      },
      callback,
    );
  }

  /**
   * This generic setter helps users calling SolidActions operation to pass a name,
   *   later used in seeding a parent OTel span for the operation.
   * @param callerName - Tracing caller name
   * @param callback - Function to run with tracing context in place
   * @returns - Return value from `callback`
   */
  static async withNamedContext<R>(callerName: string, callback: () => Promise<R>): Promise<R> {
    ensureSolidActionsIsLaunched('tracing');
    return SolidActions.#withTopContext({ operationCaller: callerName }, callback);
  }

  /**
   * Specify workflow timeout for any workflows started within the `callback`.
   * @param timeoutMS - timeout length for all workflows started within `callback` will be run
   * @param callback - Function to run, which would call or start workflows
   * @returns - Return value from `callback`
   */
  static async withWorkflowTimeout<R>(timeoutMS: number | null, callback: () => Promise<R>): Promise<R> {
    ensureSolidActionsIsLaunched('workflows');
    return SolidActions.#withTopContext({ workflowTimeoutMS: timeoutMS }, callback);
  }

  /**
   * Run a workflow with the option to set any of the contextual items
   *
   * @param options - Overrides for options
   * @param callback - Function to run, which would call or start workflows
   * @returns - Return value from `callback`
   */
  static async runWithContext<R>(options: SolidActionsContextOptions, callback: () => Promise<R>): Promise<R> {
    ensureSolidActionsIsLaunched('contexts');
    return SolidActions.#withTopContext(options, callback);
  }

  static async #withTopContext<R>(options: SolidActionsContextOptions, callback: () => Promise<R>): Promise<R> {
    const pctx = getCurrentContextStore();
    if (pctx) {
      // Save existing values and overwrite with new; hard to do cleanly but is actually type correct
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing: any = {};
      for (const k of Object.keys(options) as (keyof SolidActionsContextOptions)[]) {
        if (Object.hasOwn(pctx, k))
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          existing[k] = options[k];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (pctx as any)[k] = options[k];
      }

      try {
        return await callback();
      } finally {
        for (const k of Object.keys(options) as (keyof SolidActionsContextOptions)[]) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          if (Object.hasOwn(existing, k))
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
            (pctx as any)[k] = existing[k];
          else delete pctx[k];
        }
      }
    } else {
      return await runWithTopContext(options, callback);
    }
  }

  /**
   * Start a workflow in the background, returning a handle that can be used to check status,
   *   await the result, or otherwise interact with the workflow.
   * The full syntax is:
   * `handle = await SolidActions.startWorkflow(<target function>, <params>)(<args>);`
   * @param func - The function to start.
   * @param params - `StartWorkflowParams` which may specify the ID, queue, or other parameters for starting the workflow
   * @returns `WorkflowHandle` which can be used to interact with the started workflow
   */
  static startWorkflow<Args extends unknown[], Return>(
    target: (...args: Args) => Promise<Return>,
    params?: StartWorkflowParams,
  ): (...args: Args) => Promise<WorkflowHandle<Return>>;
  /**
   * Start a workflow in the background, returning a handle that can be used to check status, await a result,
   *   or otherwise interact with the workflow.
   * The full syntax is:
   * `handle = await SolidActions.startWorkflow(<target object>, <params>).<target method>(<args>);`
   * @param target - Object (which must be a `ConfiguredInstance`) containing the instance method to invoke
   * @param params - `StartWorkflowParams` which may specify the ID, queue, or other parameters for starting the workflow
   * @returns - `WorkflowHandle` which can be used to interact with the workflow
   */
  static startWorkflow<T extends ConfiguredInstance>(
    target: T,
    params?: StartWorkflowParams,
  ): InvokeFunctionsAsyncInst<T>;
  /**
   * Start a workflow in the background, returning a handle that can be used to check status, await a result,
   *   or otherwise interact with the workflow.
   * The full syntax is:
   * `handle = await SolidActions.startWorkflow(<target class>, <params>).<target method>(<args>);`
   * @param target - Class containing the static method to invoke
   * @param params - `StartWorkflowParams` which may specify the ID, queue, or other parameters for starting the workflow
   * @returns - `WorkflowHandle` which can be used to interact with the workflow
   */
  static startWorkflow<T extends object>(targetClass: T, params?: StartWorkflowParams): InvokeFunctionsAsync<T>;
  static startWorkflow(
    target: UntypedAsyncFunction | ConfiguredInstance | object,
    params?: StartWorkflowParams,
  ): unknown {
    ensureSolidActionsIsLaunched('workflows');
    const instance = typeof target === 'function' ? null : (target as ConfiguredInstance);
    if (instance && typeof instance !== 'function' && !(instance instanceof ConfiguredInstance)) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        'Attempt to call `startWorkflow` on an object that is not a `ConfiguredInstance`',
      );
    }

    const regOps = getRegisteredOperations(target);

    const handler: ProxyHandler<object> = {
      apply(target, _thisArg, args) {
        const regOp = getFunctionRegistration(target);
        if (!regOp) {
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          const name = typeof target === 'function' ? target.name : target.toString();
          throw new SolidActionsNotRegisteredError(name, `${name} is not a registered SolidActions workflow function`);
        }
        return SolidActions.#invokeWorkflow(instance, regOp, args, params);
      },
      get(target, p, receiver) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const func = Reflect.get(target, p, receiver);
        const regOp = getFunctionRegistration(func) ?? regOps.find((op) => op.name === p);
        if (regOp) {
          return (...args: unknown[]) => SolidActions.#invokeWorkflow(instance, regOp, args, params);
        }

        const name = typeof p === 'string' ? p : String(p);
        throw new SolidActionsNotRegisteredError(name, `${name} is not a registered SolidActions workflow function`);
      },
    };

    return new Proxy(target, handler);
  }

  /**
   * Send `message` on optional `topic` to the workflow with `destinationID`
   *  This can be done from inside or outside of SolidActions workflow functions
   *  Use the optional `idempotencyKey` to guarantee that the message is sent exactly once
   * @see `SolidActions.recv`
   *
   * @param destinationID - ID of the workflow that will `recv` the message
   * @param message - Message to send, which must be serializable as JSON
   * @param topic - Optional topic; if specified the `recv` command can specify the same topic to receive selectively
   * @param idempotencyKey - Optional key for sending the message exactly once
   */
  static async send<T>(destinationID: string, message: T, topic?: string, idempotencyKey?: string): Promise<void> {
    ensureSolidActionsIsLaunched('send');
    if (SolidActions.isWithinWorkflow()) {
      if (!SolidActions.isInWorkflow()) {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `SolidActions.send` inside a `step` or `transaction`',
        );
      }
      if (idempotencyKey) {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `SolidActions.send` with an idempotency key from within a workflow',
        );
      }
      const functionID: number = functionIDGetIncrement();
      return await SolidActionsExecutor.globalInstance!.systemDatabase.send(
        SolidActions.workflowID!,
        functionID,
        destinationID,
        SolidActions.#executor.serializer.stringify(message),
        topic,
      );
    }
    return SolidActions.#executor.runSendTempWF(destinationID, message, topic, idempotencyKey); // Temp WF variant
  }

  /**
   * Receive a message on optional `topic` from within a workflow.
   *  This must be called from within a workflow; this workflow's ID is used to check for messages sent by `SolidActions.send`
   *  This can be configured to time out.
   *  Messages are received in the order in which they are sent (per-sender / causal order).
   * @see `SolidActions.send`
   *
   * @param topic - Optional topic; if specified the `recv` command can specify the same topic to receive selectively
   * @param timeoutSeconds - Optional timeout; if no message is received before the timeout, `null` will be returned
   * @template T - The type of message that is expected to be received
   * @returns Any message received, or `null` if the timeout expires
   */
  static async recv<T>(topic?: string, timeoutSeconds?: number): Promise<T | null> {
    ensureSolidActionsIsLaunched('recv');
    if (SolidActions.isWithinWorkflow()) {
      if (!SolidActions.isInWorkflow()) {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `SolidActions.recv` inside a `step` or `transaction`',
        );
      }
      const functionID: number = functionIDGetIncrement();
      const timeoutFunctionID: number = functionIDGetIncrement();
      return SolidActions.#executor.serializer.parse(
        await SolidActionsExecutor.globalInstance!.systemDatabase.recv(
          SolidActions.workflowID!,
          functionID,
          timeoutFunctionID,
          topic,
          timeoutSeconds,
        ),
      ) as T;
    }
    throw new SolidActionsInvalidWorkflowTransitionError('Attempt to call `SolidActions.recv` outside of a workflow'); // Only workflows can recv
  }

  /**
   * Set an event, from within a SolidActions workflow.  This value can be retrieved with `SolidActions.getEvent`.
   * If the event `key` already exists, its `value` is updated.
   * This function can only be called from within a workflow.
   * @see `SolidActions.getEvent`
   *
   * @param key - The key for the event; at most one value is associated with a key at any given time.
   * @param value - The value to associate with `key`
   */
  static async setEvent<T>(key: string, value: T): Promise<void> {
    ensureSolidActionsIsLaunched('setEvent');
    if (SolidActions.isWithinWorkflow()) {
      if (!SolidActions.isInWorkflow()) {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `SolidActions.setEvent` inside a `step` or `transaction`',
        );
      }
      const functionID = functionIDGetIncrement();
      return SolidActionsExecutor.globalInstance!.systemDatabase.setEvent(
        SolidActions.workflowID!,
        functionID,
        key,
        SolidActions.#executor.serializer.stringify(value),
      );
    }
    throw new SolidActionsInvalidWorkflowTransitionError(
      'Attempt to call `SolidActions.setEvent` outside of a workflow',
    ); // Only workflows can set event
  }

  /**
   * Set the webhook response body for wait-mode webhooks.
   * When a workflow is triggered via a wait-mode webhook (response: wait),
   * this method controls what the webhook caller receives.
   *
   * Without respond(), the webhook returns the workflow's return value (which may
   * include SuperJSON wrappers). With respond(), the webhook returns exactly
   * the body you provide, as clean JSON.
   *
   * This method is idempotent — if called multiple times, the last write wins.
   * It does NOT create a durable checkpoint (no functionIDGetIncrement).
   *
   * Must be called between steps (not inside a step or transaction).
   *
   * @param body - The data to return to the webhook caller (any JSON-serializable value)
   */
  static async respond(body: unknown): Promise<void> {
    ensureSolidActionsIsLaunched('respond');
    if (!SolidActions.isWithinWorkflow()) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        'Attempt to call `SolidActions.respond` outside of a workflow',
      );
    }
    if (!SolidActions.isInWorkflow()) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        'Invalid call to `SolidActions.respond` inside a `step` or `transaction`',
      );
    }
    await SolidActionsExecutor.globalInstance!.systemDatabase.setWebhookOutput(SolidActions.workflowID!, body);
  }

  /**
   * Get the value of a workflow event, or wait for it to be set.
   * This function can be called inside or outside of SolidActions workflow functions.
   * If this function is called from within a workflow, its result is durably checkpointed.
   * @see `SolidActions.setEvent`
   *
   * @param workflowID - The ID of the workflow with the corresponding `setEvent`
   * @param key - The key for the event; at most one value is associated with a key at any given time.
   * @param timeoutSeconds - Optional timeout; if a value for `key` is not set before the timeout, `null` will be returned
   * @template T - The expected type for the value assigned to `key`
   * @returns The value to associate with `key`, or `null` if the timeout is hit
   */
  static async getEvent<T>(workflowID: string, key: string, timeoutSeconds?: number): Promise<T | null> {
    ensureSolidActionsIsLaunched('getEvent');
    if (SolidActions.isWithinWorkflow()) {
      if (!SolidActions.isInWorkflow()) {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `SolidActions.getEvent` inside a `step` or `transaction`',
        );
      }
      const functionID: number = functionIDGetIncrement();
      const timeoutFunctionID = functionIDGetIncrement();
      const params = {
        workflowID: SolidActions.workflowID!,
        functionID,
        timeoutFunctionID,
      };
      return SolidActions.#executor.serializer.parse(
        await SolidActionsExecutor.globalInstance!.systemDatabase.getEvent(
          workflowID,
          key,
          timeoutSeconds ?? SolidActionsExecutor.defaultNotificationTimeoutSec,
          params,
        ),
      ) as T;
    }
    return SolidActions.#executor.getEvent(workflowID, key, timeoutSeconds);
  }

  /**
   * Write a value to a stream.
   * @param key - The stream key/name within the workflow
   * @param value - A serializable value to write to the stream
   */
  static async writeStream<T>(key: string, value: T): Promise<void> {
    ensureSolidActionsIsLaunched('writeStream');
    if (SolidActions.isWithinWorkflow()) {
      if (SolidActions.isInWorkflow()) {
        const functionID: number = functionIDGetIncrement();
        return await SolidActionsExecutor.globalInstance!.systemDatabase.writeStreamFromWorkflow(
          SolidActions.workflowID!,
          functionID,
          key,
          value,
        );
      } else if (SolidActions.isInStep()) {
        return await SolidActionsExecutor.globalInstance!.systemDatabase.writeStreamFromStep(
          SolidActions.workflowID!,
          key,
          value,
        );
      } else {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `SolidActions.writeStream` outside of a workflow or step',
        );
      }
    } else {
      throw new SolidActionsInvalidWorkflowTransitionError(
        'Invalid call to `SolidActions.writeStream` outside of a workflow or step',
      );
    }
  }

  /**
   * Close a stream by writing a sentinel value.
   * @param key - The stream key/name within the workflow
   */
  static async closeStream(key: string): Promise<void> {
    ensureSolidActionsIsLaunched('closeStream');
    if (SolidActions.isWithinWorkflow()) {
      if (SolidActions.isInWorkflow()) {
        const functionID: number = functionIDGetIncrement();
        return await SolidActionsExecutor.globalInstance!.systemDatabase.closeStream(
          SolidActions.workflowID!,
          functionID,
          key,
        );
      } else {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to `SolidActions.closeStream` outside of a workflow or step',
        );
      }
    } else {
      throw new SolidActionsInvalidWorkflowTransitionError(
        'Invalid call to `SolidActions.closeStream` outside of a workflow',
      );
    }
  }

  /**
   * Read values from a stream as an async generator.
   * This function reads values from a stream identified by the workflowID and key,
   * yielding each value in order until the stream is closed or the workflow terminates.
   * @param workflowID - The workflow instance ID that owns the stream
   * @param key - The stream key/name within the workflow
   * @returns An async generator that yields each value in the stream until the stream is closed
   */
  static async *readStream<T>(workflowID: string, key: string): AsyncGenerator<T, void, unknown> {
    ensureSolidActionsIsLaunched('readStream');
    let offset = 0;

    while (true) {
      try {
        const value = await SolidActionsExecutor.globalInstance!.systemDatabase.readStream(workflowID, key, offset);
        if (value === SOLIDACTIONS_STREAM_CLOSED_SENTINEL) {
          break;
        }
        yield value as T;
        offset += 1;
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('No value found')) {
          // Poll the offset until a value arrives or the workflow terminates
          const status = await SolidActions.getWorkflowStatus(workflowID);
          if (!status || !isWorkflowActive(status.status)) {
            break;
          }
          await sleepms(1000); // 1 second polling interval
          continue;
        }
        throw error;
      }
    }
  }

  //////
  // Decorators
  //////

  /**
   * Allow a class to be assigned a name
   */
  static className(name: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function clsdec<T extends { new (...args: any[]): object }>(ctor: T) {
      const clsreg = getClassRegistration(ctor, true);
      if (clsreg.reg?.name && clsreg.reg.name !== name && clsreg.reg.name !== ctor.name) {
        throw new SolidActionsConflictingRegistrationError(
          `Attempt to assign name ${name} to class ${ctor.name}, which has already been aliased to ${clsreg.reg.name}`,
        );
      }
      clsreg.reg!.name = name;
    }
    return clsdec;
  }

  /**
   * Decorator designating a method as a SolidActions workflow
   *   Durable execution will be applied within calls to the workflow function
   *   This also registers the function so that it is available during recovery
   * @param config - Configuration information for the workflow
   */
  static workflow(config: WorkflowConfig = {}) {
    function decorator<This, Args extends unknown[], Return>(
      target: object,
      propertyKey: string,
      inDescriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>,
    ) {
      const { descriptor, registration } = wrapSolidActionsFunctionAndRegisterByTarget(
        target,
        propertyKey,
        config.name ?? propertyKey,
        inDescriptor,
      );
      const invoker = SolidActions.#getWorkflowInvoker(registration, config);

      descriptor.value = invoker;
      registration.wrappedFunction = invoker;
      registerFunctionWrapper(invoker, registration);

      return descriptor;
    }
    return decorator;
  }

  /** One-time guard for the registerWorkflow deprecation notice. */
  static #registerWorkflowDeprecationWarned = false;

  /**
   * Create a SolidActions workflow function from a provided function.
   *
   * @deprecated Task 2.3 — the one-shot model no longer needs an explicit
   * registration step: pass your workflow (a `defineWorkflow({ run })`
   * descriptor or a plain function) straight to `SolidActions.run()`, which now
   * routes execution through invoke(). This shim is retained so existing
   * `registerWorkflow(...)` call sites keep working (the returned value is still
   * the legacy callable wrapper, and `run()` recovers the underlying function
   * from it) — but it is on the Task 2.4c convergence path and will be removed.
   *
   * @param func - The function to register as a workflow
   * @param config - Configuration information for the registered workflow
   */
  static registerWorkflow<This, Args extends unknown[], Return>(
    func: (this: This, ...args: Args) => Promise<Return>,
    config?: FunctionName & WorkflowConfig,
  ): (this: This, ...args: Args) => Promise<Return> {
    if (!SolidActions.#registerWorkflowDeprecationWarned) {
      SolidActions.#registerWorkflowDeprecationWarned = true;
      console.warn(
        '[SolidActions] SolidActions.registerWorkflow() is deprecated: pass your workflow ' +
          '(a defineWorkflow({ run }) descriptor or a plain function) directly to ' +
          'SolidActions.run(). registerWorkflow() will be removed in a future release.',
      );
    }
    // Task 2.4c: still returns the legacy callable wrapper + registration so the
    // legacy executor path and existing call sites keep working; run() recovers
    // origFunction from this registration. Collapses when the legacy path goes.
    // Anonymous functions (e.g. `registerWorkflow(async () => ...)`) all have
    // an empty `.name`, so two of them would collide in the by-unique-name
    // registry and throw SolidActionsConflictingRegistrationError. The one-shot
    // run() path recovers the user fn via origFunction, not by registry name,
    // so the name is no longer load-bearing here — give anonymous workflows a
    // unique fallback name in this deprecated shim. Explicit `config.name` and
    // named functions are unchanged (so decorator/legacy call sites are
    // unaffected). Task 2.4c: removed with the legacy registration coupling.
    const explicitName = config?.name ?? (func.name || undefined);
    const wfName = explicitName ?? `__anon_workflow_${++SolidActions.#anonWorkflowSeq}`;
    const registration = wrapSolidActionsFunctionAndRegisterByUniqueName(
      config?.ctorOrProto,
      config?.className,
      wfName,
      wfName,
      func,
    );
    return SolidActions.#getWorkflowInvoker(registration, config);
  }

  /** Monotonic counter for anonymous-workflow fallback names (Task 2.3 shim). */
  static #anonWorkflowSeq = 0;

  static async #invokeWorkflow<This, Args extends unknown[], Return>(
    $this: This,
    regOP: MethodRegistrationBase,
    args: Args,
    params: StartWorkflowParams = {},
    startWfFuncId?: number,
  ): Promise<InternalWFHandle<Return>> {
    ensureSolidActionsIsLaunched('workflows');
    const wfId = getNextWFID(params.workflowID);
    const ppctx = getCurrentContextStore();

    const queueName = params.queueName ?? ppctx?.queueAssignedForWorkflows;
    const timeoutMS = params.timeoutMS ?? ppctx?.workflowTimeoutMS;

    const instance = $this === undefined || typeof $this === 'function' ? undefined : ($this as ConfiguredInstance);
    if (instance && !(instance instanceof ConfiguredInstance)) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        'Attempt to call a `workflow` function on an object that is not a `ConfiguredInstance`',
      );
    }

    // If this is called from within a workflow, this is a child workflow,
    //  For OAOO, we will need a consistent ID formed from the parent WF and call number
    if (SolidActions.isWithinWorkflow()) {
      if (!SolidActions.isInWorkflow()) {
        throw new SolidActionsInvalidWorkflowTransitionError(
          'Invalid call to a `workflow` function from within a `step` or `transaction`',
        );
      }

      const funcId = startWfFuncId ?? functionIDGetIncrement();
      const pctx = getCurrentContextStore()!;
      const pwfid = pctx.workflowId!;
      const wfParams: WorkflowParams = {
        workflowUUID: wfId || pwfid + '-' + funcId,
        configuredInstance: instance,
        queueName,
        timeoutMS,
        // Detach child deadline if a null timeout is configured
        deadlineEpochMS:
          params.timeoutMS === null || pctx?.workflowTimeoutMS === null ? undefined : pctx?.deadlineEpochMS,
        enqueueOptions: params.enqueueOptions,
      };

      return await invokeRegOp(wfParams, pwfid, funcId);
    } else {
      const wfParams: InternalWorkflowParams = {
        workflowUUID: wfId,
        queueName,
        enqueueOptions: params.enqueueOptions,
        configuredInstance: instance,
        timeoutMS,
      };

      return await invokeRegOp(wfParams, undefined, undefined);
    }

    function invokeRegOp(wfParams: WorkflowParams, workflowID: string | undefined, funcNum: number | undefined) {
      if (regOP.workflowConfig) {
        const func = regOP.registeredFunction as TypedAsyncFunction<Args, Return>;
        return SolidActionsExecutor.globalInstance!.internalWorkflow(func, wfParams, workflowID, funcNum, ...args);
      }
      if (regOP.stepConfig) {
        const func = regOP.registeredFunction as TypedAsyncFunction<Args, Return>;
        return SolidActionsExecutor.globalInstance!.startStepTempWF(func, wfParams, workflowID, funcNum, ...args);
      }

      throw new SolidActionsNotRegisteredError(
        regOP.name,
        `${regOP.name} is not a registered SolidActions workflow, step, or transaction function`,
      );
    }
  }

  static #getWorkflowInvoker<This, Args extends unknown[], Return>(
    registration: MethodRegistration<This, Args, Return>,
    config: WorkflowConfig | undefined,
  ): (this: This, ...args: Args) => Promise<Return> {
    registration.setWorkflowConfig(config ?? {});
    const invoker = async function (this: This, ...rawArgs: Args): Promise<Return> {
      ensureSolidActionsIsLaunched('workflows');
      if (SolidActions.isInWorkflow()) {
        const startWfFuncId = functionIDGetIncrement();
        const getResFuncID = functionIDGetIncrement();
        const handle = await SolidActions.#invokeWorkflow<This, Args, Return>(
          this,
          registration,
          rawArgs,
          undefined,
          startWfFuncId,
        );
        return await handle.getResult(getResFuncID);
      }
      const handle = await SolidActions.#invokeWorkflow<This, Args, Return>(this, registration, rawArgs);
      return await handle.getResult();
    };
    registerFunctionWrapper(invoker, registration as MethodRegistration<unknown, unknown[], unknown>);
    Object.defineProperty(invoker, 'name', {
      value: registration.name,
    });
    return invoker;
  }

  /**
   * Decorator designating a method as a SolidActions step.
   *   A durable checkpoint will be made after the step completes
   *   This ensures "at least once" execution of the step, and that the step will not
   *    be executed again once the checkpoint is recorded
   *
   * @param config - Configuration information for the step, particularly the retry policy
   */
  static step(config: StepConfig = {}) {
    function decorator<This, Args extends unknown[], Return>(
      target: object,
      propertyKey: string,
      inDescriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>,
    ) {
      const { descriptor, registration } = wrapSolidActionsFunctionAndRegisterByTarget(
        target,
        propertyKey,
        config.name,
        inDescriptor,
      );
      registration.setStepConfig(config);

      const invokeWrapper = async function (this: This, ...rawArgs: Args): Promise<Return> {
        ensureSolidActionsIsLaunched('steps');
        let inst: ConfiguredInstance | undefined = undefined;
        if (this === undefined || typeof this === 'function') {
          // This is static
        } else {
          inst = this as ConfiguredInstance;
          if (!(inst instanceof ConfiguredInstance)) {
            throw new SolidActionsInvalidWorkflowTransitionError(
              'Attempt to call a `step` function on an object that is not a `ConfiguredInstance`',
            );
          }
        }

        if (SolidActions.isWithinWorkflow()) {
          if (SolidActions.isInTransaction()) {
            throw new SolidActionsInvalidWorkflowTransitionError(
              'Invalid call to a `step` function from within a `transaction`',
            );
          }
          if (SolidActions.isInStep()) {
            // There should probably be checks here about the compatibility of the StepConfig...
            return registration.registeredFunction!.call(this, ...rawArgs);
          }
          return await SolidActionsExecutor.globalInstance!.callStepFunction(
            registration.registeredFunction as unknown as TypedAsyncFunction<Args, Return>,
            undefined,
            undefined,
            inst ?? null,
            ...rawArgs,
          );
        }

        const wfId = getNextWFID(undefined);

        const wfParams: WorkflowParams = {
          configuredInstance: inst,
          workflowUUID: wfId,
        };

        return await SolidActions.#executor.runStepTempWF(
          registration.registeredFunction as TypedAsyncFunction<Args, Return>,
          wfParams,
          ...rawArgs,
        );
      };

      descriptor.value = invokeWrapper;
      registration.wrappedFunction = invokeWrapper;
      registerFunctionWrapper(invokeWrapper, registration);

      Object.defineProperty(invokeWrapper, 'name', {
        value: registration.name,
      });

      return descriptor;
    }
    return decorator;
  }

  /**
   * Create a check pointed SolidActions step function from  a provided function
   *   Similar to the SolidActions.step decorator, but without requiring a decorator
   *   A durable checkpoint will be made after the step completes
   *   This ensures "at least once" execution of the step, and that the step will not
   *    be executed again once the checkpoint is recorded
   * @param func - The function to register as a step
   * @param config - Configuration information for the step, particularly the retry policy and name
   */
  static registerStep<This, Args extends unknown[], Return>(
    func: (this: This, ...args: Args) => Promise<Return>,
    config: StepConfig & FunctionName = {},
  ): (this: This, ...args: Args) => Promise<Return> {
    const name = config.name ?? func.name;

    const reg = wrapSolidActionsFunctionAndRegister(config?.ctorOrProto, config?.className, name, name, func);

    const invokeWrapper = async function (this: This, ...rawArgs: Args): Promise<Return> {
      ensureSolidActionsIsLaunched('steps');

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const inst = this;
      const callFunc = reg.registeredFunction ?? reg.origFunction;

      if (SolidActions.isWithinWorkflow()) {
        if (SolidActions.isInTransaction()) {
          throw new SolidActionsInvalidWorkflowTransitionError(
            'Invalid call to a `step` function from within a `transaction`',
          );
        }
        if (SolidActions.isInStep()) {
          // There should probably be checks here about the compatibility of the StepConfig...
          return callFunc.call(this, ...rawArgs);
        }
        return await SolidActionsExecutor.globalInstance!.callStepFunction(
          callFunc as TypedAsyncFunction<Args, Return>,
          name,
          config,
          inst ?? null,
          ...rawArgs,
        );
      }

      if (getNextWFID(undefined)) {
        throw new SolidActionsInvalidWorkflowTransitionError(
          `Invalid call to step '${name}' outside of a workflow; with directive to start a workflow.`,
        );
      }
      return callFunc.call(this, ...rawArgs);
    };

    registerFunctionWrapper(invokeWrapper, reg);

    Object.defineProperty(invokeWrapper, 'name', { value: name });
    return invokeWrapper;
  }

  /**
   * Run the enclosed `callback` as a checkpointed step within a SolidActions workflow
   * @param callback - function containing code to run
   * @param config - Configuration information for the step, particularly the retry policy
   * @param config.name - The name of the step; if not provided, the function name will be used
   * @returns - result (either obtained from invoking function, or retrieved if run before)
   */
  static runStep<Return>(
    func: () => Return | Promise<Return>,
    config: StepConfig & { name?: string } = {},
  ): Promise<Return> {
    const name = config.name ?? func.name;

    // Task 2.3: when a legacy-registered workflow body runs under the one-shot
    // run() path it executes inside invoke()'s ALS scope. Delegate to invoke()'s
    // OWN step primitive (single source of truth: record-or-replay against the
    // per-request InvokeSystemDatabase). ensureSolidActionsIsLaunched() is a
    // legacy-launch guard that does not apply to the invoke() path, so it is
    // intentionally skipped here.
    const invokePrimitives = getCurrentPrimitives();
    if (invokePrimitives) {
      return invokePrimitives.step<Return>(func, { name });
    }

    ensureSolidActionsIsLaunched('steps');

    if (SolidActions.isWithinWorkflow()) {
      if (SolidActions.isInTransaction()) {
        throw new SolidActionsInvalidWorkflowTransitionError('Invalid call to a runStep from within a `transaction`');
      }
      if (SolidActions.isInStep()) {
        // There should probably be checks here about the compatibility of the StepConfig...
        // Promise.resolve normalizes the now-sync-or-async func() to Promise<Return>
        // (no behavior change: an already-Promise is returned as-is).
        return Promise.resolve(func());
      }
      return SolidActionsExecutor.globalInstance!.callStepFunction<[], Return>(
        func as unknown as TypedAsyncFunction<[], Return>,
        name,
        config,
        null,
      );
    }

    if (getNextWFID(undefined)) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        `Invalid call to step '${name}' outside of a workflow; with directive to start a workflow.`,
      );
    }

    return Promise.resolve(func());
  }

  /**
   * Register serialization recipe; this is used to save/retrieve objects from the SolidActions system
   *  database.  This includes workflow inputs, function return values, messages, and events.
   */
  static registerSerialization<T, S extends JSONValue>(serReg: SerializationRecipe<T, S>) {
    if (SolidActions.isInitialized()) {
      throw new TypeError(`Serializers/deserializers should not be registered after SolidActions.launch()`);
    }
    registerSerializationRecipe(serReg);
  }

  /**
   * Decorate a class with the default list of required roles.
   *   This class-level default can be overridden on a per-function basis with `requiredRole`.
   * @param anyOf - The list of roles allowed access; authorization is granted if the authenticated user has any role on the list
   */
  static defaultRequiredRole(anyOf: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function clsdec<T extends { new (...args: any[]): object }>(ctor: T) {
      const clsreg = associateClassWithExternal(SOLIDACTIONS_AUTH, ctor) as ClassAuthDefaults;
      clsreg.requiredRole = anyOf;
      registerAuthChecker();
    }
    return clsdec;
  }

  /**
   * Decorate a method with the default list of required roles.
   * @see `SolidActions.defaultRequiredRole`
   * @param anyOf - The list of roles allowed access; authorization is granted if the authenticated user has any role on the list
   */
  static requiredRole(anyOf: string[]) {
    function apidec<This, Args extends unknown[], Return>(
      target: object,
      propertyKey: string,
      inDescriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>,
    ) {
      const rr = associateMethodWithExternal(
        SOLIDACTIONS_AUTH,
        target,
        undefined,
        propertyKey.toString(),
        inDescriptor.value!,
      );

      (rr.regInfo as MethodAuth).requiredRole = anyOf;
      registerAuthChecker();

      inDescriptor.value = rr.registration.wrappedFunction ?? rr.registration.registeredFunction;

      return inDescriptor;
    }
    return apidec;
  }

  /////
  // Patching
  /////

  /**
   * Check if a workflow execution has been patched.
   *
   * Patching allows reexecution of workflows to accommate changes to the workflow logic.
   *
   * Patches check the system database to see which code branch to take.  As this adds overhead,
   *  they may eventually be removed; see `deprecatePatch`.
   *
   * @param patchName Name of the patch to check.
   * @returns true if this is the patched(new) workflow variant, or false if the execution predates the patch
   */
  static async patch(patchName: string): Promise<boolean> {
    if (!SolidActions.isInWorkflow()) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        '`SolidActions.patch` must be called from a workflow, and not within a step',
      );
    }

    if (!SolidActions.#solidActionsConfig?.enablePatching) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        'Patching is not enabled.  See `enablePatching` in `SolidActionsConfig`',
      );
    }

    const patched = await SolidActionsExecutor.globalInstance!.systemDatabase.checkPatch(
      SolidActions.workflowID!,
      functionIDGet(),
      patchName,
      false,
    );
    if (patched.hasEntry) {
      functionIDGetIncrement();
    }
    return patched.isPatched;
  }

  /**
   * Check if a workflow execution has been patched, within a plan to eventually remove the unpatched (old) variant.
   *
   * `patch` may be changed to `deprecatePatch` after all unpatched workflows have completed and will not be reexecuted.
   * Once all workflows started with `patch` have completed (in favor of those using `deprecatePatch`), the `deprecatePatch` may then be removed.
   *
   * @param patchName Name of the patch to check.
   * @returns true if this is the patched(new) workflow variant, which it should always be if all unpatched workflows have been retired
   */
  static async deprecatePatch(patchName: string): Promise<boolean> {
    if (!SolidActions.isInWorkflow()) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        '`SolidActions.deprecatePatch` must be called from a workflow, and not within a step',
      );
    }

    if (!SolidActions.#solidActionsConfig?.enablePatching) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        'Patching is not enabled.  See `enablePatching` in `SolidActionsConfig`',
      );
    }

    const patched = await SolidActionsExecutor.globalInstance!.systemDatabase.checkPatch(
      SolidActions.workflowID!,
      functionIDGet(),
      patchName,
      true,
    );
    if (patched.hasEntry) {
      functionIDGetIncrement();
    }
    return patched.isPatched;
  }

  /////
  // Registration, etc
  /////

  /**
   * Register a lifecycle listener
   */
  static registerLifecycleCallback(lcl: SolidActionsLifecycleCallback) {
    registerLifecycleCallback(lcl);
  }

  /**
   * Register a middleware provider
   */
  static registerMiddlewareInstaller(mwp: SolidActionsMethodMiddlewareInstaller) {
    registerMiddlewareInstaller(mwp);
  }

  /**
   * Register information to be associated with a SolidActions class
   */
  static associateClassWithInfo(external: AnyConstructor | object | string, cls: AnyConstructor | string): object {
    return associateClassWithExternal(external, cls);
  }

  /**
   * Register information to be associated with a SolidActions function
   */
  static associateFunctionWithInfo<This, Args extends unknown[], Return>(
    external: AnyConstructor | object | string,
    func: (this: This, ...args: Args) => Promise<Return>,
    target: FunctionName,
  ) {
    return associateMethodWithExternal(external, target.ctorOrProto, target.className, target.name ?? func.name, func);
  }

  /**
   * Register information to be associated with a SolidActions function
   */
  static associateParamWithInfo<This, Args extends unknown[], Return>(
    external: AnyConstructor | object | string,
    func: ((this: This, ...args: Args) => Promise<Return>) | undefined,
    target: FunctionName & {
      param: number | string;
    },
  ) {
    return associateParameterWithExternal(
      external,
      target.ctorOrProto,
      target.className,
      target.name ?? func?.name ?? '<unknown>',
      func,
      target.param,
    );
  }

  /** Get registrations */
  static getAssociatedInfo(
    external: AnyConstructor | object | string,
    cls?: object | string,
    funcName?: string,
  ): readonly ExternalRegistration[] {
    return getRegistrationsForExternal(external, cls, funcName);
  }
}
