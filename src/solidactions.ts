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
  WorkflowNotRegisteredError,
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
import { JSONValue, registerSerializationRecipe, SerializationRecipe, SolidActionsJSON } from './serialization';
import { SolidActionsAdminServer } from './adminserver';
import { Server } from 'http';

import { randomUUID } from 'node:crypto';

import { StepConfig } from './step';
// Task 2.3: the one-shot compat path — run() = ContextAdapter -> invoke() -> RuntimeAdapter.
//
// invoke()/contextAdapter/runtimeAdapter/HttpClient are required LAZILY inside
// run()/#initOneShotStatusRow/#reportOneShotTerminalState (call-time require()) to avoid a module-load
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
import { getCurrentPrimitives, getCurrentScope, nextFunctionID } from './invoke/runtime-scope';
import { invokeStartChildWorkflow, invokeStartChildWorkflowByName } from './invoke/child-workflow';
import type { WorkflowDescriptor, InvokeResult, InvokeCtx } from './invoke/types';
// Task A.1 (Blaxel MVP): run-status-lifecycle extracted from SolidActions.run()
// so runResident() can reuse the exact wire shapes without drift. Static import
// is safe: secret-redaction is a leaf module (no transitive deps that
// re-enter the solidactions.ts module load), and run-status-lifecycle only
// imports from secret-redaction + ../workflow + ../serialization — none of which
// re-enter this file.
import { initRunStatusRow, reportTerminalState } from './invoke/run-status-lifecycle';
import {
  __getRegisteredWorkflow,
  __getRegisteredWorkflows,
  registerWorkflowDescriptor,
  resolveWorkflowName,
} from './invoke/registry';
import { Conductor } from './conductor/conductor';
import { EnqueueOptions, SOLIDACTIONS_STREAM_CLOSED_SENTINEL } from './system_database';
import { registerAuthChecker } from './authdecorators';
import assert from 'node:assert';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Entrypoint-identity dispatch-guard process-global state (Codex Option 1A).
 *
 * The one-shot contract evaluates a deployed workflow's entrypoint module which
 * calls top-level `SolidActions.runIfEntrypoint(wf, import.meta.url)`. A parent
 * that `import`s a child whose own module has a top-level
 * `runIfEntrypoint(childTask, import.meta.url)` would, WITHOUT this guard, run
 * the CHILD body against the PARENT's input (Node fully evaluates the imported
 * module — including its top-level call — before the importer's body). The
 * guard in `runIfEntrypoint()` compares the CALLER MODULE's resolved path
 * against `process.argv[1]` (the file Node was invoked with — the runner's
 * `node dist/<file>.js`) and makes the imported module's call an inert no-op.
 *
 * Entrypoint identity (file === argv[1]) is alias-safe: a single source file
 * deployed under N solidactions.yaml ids registers ONE workflow name but is the
 * legitimate entrypoint under every alias. The old name==WORKFLOW_SLUG match
 * regressed that pattern (registered name `simple-steps` ≠ deployed slug
 * `webhook-test` → the real entrypoint was silently no-opped). File identity
 * has no name dependency, so the alias entrypoint always runs.
 *
 * These module-level flags + the single `process.on('exit')` handler turn a
 * genuine entrypoint/codemod misconfig (the dispatched one-shot module's
 * top-level call was SKIPPED as non-entrypoint and NOTHING ran) into a loud
 * non-zero exit instead of a silent never-runs hang.
 */
let __anyEntrypointRunExecuted = false;
let __anyRunSkippedForNonEntrypoint = false;
let __failLoudExitHandlerInstalled = false;

/**
 * Test-only snapshots of the entrypoint-guard flags. Used by the guard suite to
 * assert flag transitions without driving the real `process.on('exit')`
 * handler. NOT part of the public API and intentionally NOT re-exported from
 * `src/index.ts`.
 */
export function __entrypointGuardFlags(): {
  executed: boolean;
  skipped: boolean;
} {
  return {
    executed: __anyEntrypointRunExecuted,
    skipped: __anyRunSkippedForNonEntrypoint,
  };
}

/**
 * Synchronously decide whether `callerUrl` is the process entrypoint module.
 *
 * The runner dispatches a one-shot run as `node dist/<file>.js`, so
 * `process.argv[1]` is the absolute path of the built entrypoint file. ESM
 * modules pass `import.meta.url` (a `file:` URL); a path string is also
 * accepted. We resolve both sides to absolute paths and compare for identity.
 *
 * Fully synchronous and total: never throws on odd input. If `process.argv[1]`
 * is missing/empty (e.g. `node -e`, REPL, some test harnesses) we cannot
 * identify an entrypoint and return `false` safely.
 *
 * @param callerUrl - the calling module's `import.meta.url` (a `file:` URL) or
 *   a filesystem path.
 * @returns true iff the resolved caller path === resolved `process.argv[1]`.
 */
export function isEntrypointModule(callerUrl: string): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string' || argv1.length === 0) {
    return false;
  }
  if (typeof callerUrl !== 'string' || callerUrl.length === 0) {
    return false;
  }

  let callerPath: string;
  try {
    callerPath = callerUrl.startsWith('file:') ? fileURLToPath(callerUrl) : callerUrl;
  } catch {
    // Malformed file: URL — cannot identify; fail safe (not entrypoint).
    return false;
  }

  let resolvedCaller: string;
  let resolvedArgv1: string;
  try {
    resolvedCaller = nodePath.resolve(callerPath);
    resolvedArgv1 = nodePath.resolve(argv1);
  } catch {
    return false;
  }

  return resolvedCaller === resolvedArgv1;
}

/**
 * Pure decision for the fail-loud `process.on('exit')` handler.
 *
 * Returns true ONLY when this process is a dispatched one-shot run
 * (`oneShotPresent`), at least one `runIfEntrypoint()` was SKIPPED as
 * non-entrypoint, and NO `runIfEntrypoint()` ever executed at the entrypoint —
 * i.e. a genuine entrypoint/codemod misconfiguration where the process would
 * otherwise exit 0 having run nothing. It must NOT fire for:
 *   - the legitimate imported-child no-op (the entrypoint's OWN call DID
 *     execute → `executed` is true),
 *   - a standalone/alias entrypoint that executed (`executed` true),
 *   - a non-one-shot process (legacy/mock/local — guard inactive),
 *   - a direct `SolidActions.run()` (non-runIfEntrypoint) usage — it never
 *     sets `skipped`.
 *
 * Factored out as a pure function so it is unit-testable without driving the
 * real `process.on('exit')` handler under jest.
 *
 * @param oneShotPresent - whether this process is a dispatched one-shot run
 *   (presence of `SOLIDACTIONS_RUN_ID`).
 * @param executed - `__anyEntrypointRunExecuted` at exit time.
 * @param skipped - `__anyRunSkippedForNonEntrypoint` at exit time.
 */
export function __shouldFailLoudOnExit(oneShotPresent: boolean, executed: boolean, skipped: boolean): boolean {
  return oneShotPresent && !executed && skipped;
}

/**
 * Pure decision for the exit code the fail-loud handler should set.
 *
 * The fail-loud handler signals a deploy/entrypoint misconfig with a non-zero
 * exit code. It must NEVER downgrade or clobber an existing non-zero
 * `process.exitCode` — if the process already failed for some OTHER reason
 * (a thrown error, an explicit `process.exit(2)`, etc.) that code is the
 * truthful failure signal and must survive. So:
 *
 *   - current code is unset (undefined) or 0 → return 1 (we own the failure
 *     signal: the only reason this process is exiting is the misconfig).
 *   - current code is already non-zero → return undefined (DO NOT touch it;
 *     the existing code is more specific / already-true).
 *
 * Factored out as a pure function so the "never clobber a non-zero code"
 * invariant is unit-testable without driving the real exit handler.
 *
 * @param currentCode - the value of `process.exitCode` at exit time.
 * @returns 1 when the handler should set the code, or undefined to leave it.
 */
export function __failLoudExitCode(currentCode: number | string | undefined | null): number | undefined {
  // Treat undefined / null / 0 (and the string '0') as "unset/success" — only
  // those are safe to overwrite with our misconfig signal.
  if (currentCode === undefined || currentCode === null || currentCode === 0 || currentCode === '0') {
    return 1;
  }
  return undefined;
}

/**
 * Whether this process is a dispatched one-shot run.
 *
 * `SOLIDACTIONS_RUN_ID` is injected by the app (RuntimeEnvBuilder.php:59 =
 * `$trigger->run_uuid`) on EVERY dispatched trigger and maps to
 * `ctx.run.runUuid` (context-adapter.ts:117). It is the cleanest "this process
 * IS a dispatched one-shot run" signal: present on every real one-shot run,
 * absent for legacy/mock/local/direct-`run()` usage, and — unlike the retired
 * `WORKFLOW_SLUG` — NOT a name matcher (Codex Option 1A removes the name
 * dependency entirely). The fail-loud handler only arms when this is present.
 */
function __oneShotModePresent(): boolean {
  const runId = process.env.SOLIDACTIONS_RUN_ID;
  return typeof runId === 'string' && runId.length > 0;
}

/**
 * Install (once) the fail-loud `process.on('exit')` handler. Idempotent: the
 * handler is registered a single time for the process lifetime; it reads the
 * live module-level flags at exit so multiple `runIfEntrypoint()` calls in one
 * process (imported-child then real entrypoint) are accounted for.
 */
function __installFailLoudExitHandler(): void {
  if (__failLoudExitHandlerInstalled) {
    return;
  }
  __failLoudExitHandlerInstalled = true;
  process.on('exit', () => {
    if (__shouldFailLoudOnExit(__oneShotModePresent(), __anyEntrypointRunExecuted, __anyRunSkippedForNonEntrypoint)) {
      console.error(
        `[solidactions] FATAL: the dispatched one-shot module's top-level ` +
          `runIfEntrypoint() was skipped as non-entrypoint and NO workflow ran ` +
          `(SOLIDACTIONS_RUN_ID=${String(process.env.SOLIDACTIONS_RUN_ID)}, ` +
          `argv[1]=${String(process.argv[1])}) — entrypoint/codemod mismatch`,
      );
      // Signal failure without forcing exit from within an exit handler
      // (process.exit() inside 'exit' is a no-op / unsafe — set the code).
      // NEVER clobber an existing non-zero exitCode: if the process already
      // failed for another reason, that code is the truthful signal. Only set
      // 1 when the current code is unset/0 (see __failLoudExitCode).
      const failCode = __failLoudExitCode(process.exitCode);
      if (failCode !== undefined) {
        process.exitCode = failCode;
      }
    }
  });
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
   * Run a workflow ONLY when the calling module is the process entrypoint
   * (Codex Option 1A — entrypoint-identity dispatch guard).
   *
   * Deployed workflow modules call this at top level instead of
   * `SolidActions.run(wf)`:
   *
   * ```typescript
   * SolidActions.runIfEntrypoint(myWorkflow, import.meta.url);
   * ```
   *
   * WHY: the one-shot contract evaluates a deployed module which self-invokes at
   * top level. A parent that `import`s a child module to `startWorkflow()` it
   * would, with a bare top-level `run(childTask)`, run the CHILD body against
   * the PARENT's input — Node fully evaluates the imported module (including its
   * top-level call) before the importer's body. `runIfEntrypoint` makes the
   * IMPORTED module's top-level call an inert no-op while the real entrypoint's
   * call runs.
   *
   * Identity is the calling module vs `process.argv[1]` (the file the runner
   * invoked: `node dist/<file>.js`). This is ALIAS-SAFE: one source file
   * deployed under N solidactions.yaml ids is still its own entrypoint under
   * every alias (file === argv[1]), with NO dependence on the registered
   * workflow name vs the deployed slug — the exact regression the retired
   * name==WORKFLOW_SLUG guard caused.
   *
   * Behavior:
   * - Caller IS the entrypoint → delegates to {@link SolidActions.run} with the
   *   same signature/return (runs the one-shot init/invoke/terminal-state flow).
   * - Caller is NOT the entrypoint (imported-module side-effect) → returns a
   *   resolved promise IMMEDIATELY: NO invoke, NO status-row writes, NO
   *   process.exit. Control returns cleanly to the importing module.
   *
   * Synchronous up to the early non-entrypoint return (the method is `async`,
   * so the identity check + return run before the caller's first microtask —
   * that ordering is what neutralizes the imported child's top-level call). The
   * non-entrypoint path resolves; it never rejects.
   *
   * A `process.on('exit')` fail-loud handler is armed so a genuine
   * entrypoint/codemod misconfig (the dispatched one-shot module was skipped as
   * non-entrypoint and NOTHING ran) becomes a loud non-zero exit instead of a
   * silent never-runs hang. It fires ONLY when this process is a dispatched
   * one-shot run AND a run was skipped AND none executed (see
   * {@link __shouldFailLoudOnExit}).
   *
   * @param workflow  - the same value `run()` accepts (descriptor, registered
   *   wrapper, or bare fn). No name dependency anywhere.
   * @param callerUrl - the calling module's `import.meta.url` (ESM) or path.
   * @param options   - forwarded verbatim to {@link SolidActions.run}.
   */
  static runIfEntrypoint<T, R>(
    workflow: WorkflowDescriptor<T, R> | ((input: T) => R | Promise<R>),
    callerUrl: string,
    options?: {
      input?: T;
      workflowID?: string;
    },
  ): Promise<void> {
    if (isEntrypointModule(callerUrl)) {
      // This module IS the process entrypoint — the legitimate dispatched
      // one-shot (or a standalone/alias entrypoint). Record that an entrypoint
      // run executed, arm the fail-loud handler (it stays silent because
      // executed === true), and delegate to run() with the identical
      // signature/return.
      __anyEntrypointRunExecuted = true;
      __installFailLoudExitHandler();
      return SolidActions.run(workflow, options);
    }

    // Not the entrypoint — this is an IMPORTED module's top-level call (e.g. a
    // parent importing a child for startWorkflow()). Record the skip, arm the
    // fail-loud handler so a true misconfig (the dispatched module itself was
    // skipped and nothing ran) is detectable, and return a RESOLVED promise
    // immediately: NO invoke(), NO status-row writes, NO process.exit().
    // Control returns cleanly to the importing module; the unawaited resolved
    // promise produces no unhandledRejection.
    __anyRunSkippedForNonEntrypoint = true;
    __installFailLoudExitHandler();
    return Promise.resolve();
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
   * NOTE: `run()` itself is UNGUARDED — it always invokes the workflow. The
   * imported-child hijack is prevented at the call site by
   * {@link SolidActions.runIfEntrypoint}, which deployed entrypoint modules use
   * for their top-level self-invoke. A bare `SolidActions.run()` is intentional
   * direct invocation and runs.
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
    const ctx = await oneShotContextAdapter(process.env as Record<string, string>);

    // Derive workflowName the way the legacy executor did
    // (src/solidactions-executor.ts:374-375 `wfname = getRegisteredFunctionFullName(wf).name`;
    // src/decorators.ts:566-575: registered → `fr.name`, else the function's own
    // `.name`). The one-shot `workflow` arg is the SAME value legacy received
    // (a registerWorkflow wrapper, a bare fn, or a { run } descriptor), so
    // resolve it identically — from the registration's `.name` if registered,
    // else the function's `.name`. A non-empty fallback is required: the real
    // RunStatusController::store() validates `workflowName => required|string`
    // and Laravel's `required` rejects an empty string.
    const workflowReg = getFunctionRegistration(workflow as object);
    const workflowName = workflowReg?.name || (workflow as { name?: string }).name || 'workflow';

    // Reproduce the legacy backend status-row lifecycle. Legacy run() persisted
    // it via the executor's THREE-step sequence (src/solidactions-executor.ts
    // internalWorkflow / runWorkflow / handleWorkflowError), and CRUCIALLY the
    // CREATE happened DURING internalWorkflow() — BEFORE the user body ran:
    //   0. systemDatabase.initWorkflowStatus (src/solidactions-executor.ts:464
    //      `POST /runs/status` with the `internalStatus` body built at
    //      :407-428) — CREATES the RunStatus row. The real backend's
    //      RunStatusController::recordOutput/recordError AND the per-step
    //      recordOperationResult (`POST /runs/status/<id>/operations`) all 404
    //      ("Run not found"; no upsert) when the row is absent, and
    //      DispatchTriggerToDaytona never creates it. The legacy executor
    //      created the row in internalWorkflow() BEFORE running the user body,
    //      so the body's step()→recordOperationResult always hit an existing
    //      row. store() is idempotent for an existing PENDING/ENQUEUED row.
    //   1. systemDatabase.recordWorkflowOutput / recordWorkflowError —
    //      `PUT /runs/status/<id>/output|error` with {output|error, status}.
    //      This is the ONLY write the real Laravel backend persists into
    //      RunStatus.output|error (RunStatusController::workflowComplete
    //      DISCARDS the POST body's output/error and only syncs status).
    //   2. systemDatabase.reportWorkflowComplete —
    //      `POST /runs/status/<id>/workflow-complete` — a fire-and-forget infra
    //      signal whose errors are swallowed.
    //
    // Task 2.4b ORDERING FIX (real-Daytona parity break): step 0 (the row
    // CREATE) MUST run BEFORE invoke() executes the workflow body. The body's
    // step() → InvokeSystemDatabase.recordOperationResult POSTs
    // `/runs/status/<id>/operations`, which 404s "Run not found" if the row
    // doesn't exist yet. Previously the CREATE lived in
    // #reportOneShotCompletion (POST-invoke), inverting create-vs-run and
    // recording every step-ful run FAILED on real Daytona. Restored to the
    // legacy ordering: #initOneShotStatusRow (before invoke) +
    // #reportOneShotTerminalState (after).
    //
    // Every identity field comes strictly from ctx (the ALS/ctx scope) —
    // NEVER bootParams (re-reading bootParams would re-globalize the row, the
    // exact regression deglobalization removed):
    //   workflowUUID       = ctx.run.runUuid
    //   executorId         = ctx.run.triggerId
    //   applicationID      = ctx.app.appId
    //   applicationVersion = ctx.app.appVersion
    //   createdAt          = Date.now()
    //   workflowName       = derived above (legacy getRegisteredFunctionFullName)
    //
    // The CREATE is awaited BEFORE invoke() regardless of the eventual outcome:
    // suspended runs need the row too (their durable sleep/recv schedule POSTs
    // are `/runs/status/<id>/...` sub-routes that 404 on an absent row).
    await initRunStatusRow(ctx, workflowName);

    // ctx.input is `unknown` until the engine parses WORKFLOW_INPUT; the workflow
    // descriptor re-applies <T>, so this widening cast is sound.
    const result = await invoke<T, R>(descriptor, ctx as unknown as InvokeCtx<T>);

    // Steps 1+2: the durable status-row PUT then the fire-and-forget POST,
    // reproduced from the InvokeResult AFTER invoke() returns (as before).
    await reportTerminalState(ctx, result);

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
   * Interface for signal URLs returned by getSignalUrls()
   */
  static getSignalUrls(topic?: string): {
    base: string;
    approve: string;
    reject: string;
    custom: (action: string) => string;
  } {
    // Task 2.6: under the one-shot run() path a legacy-API body runs inside
    // invoke()'s ALS scope, which carries the public API base URL sourced
    // strictly from ctx.api.url (threaded into runtimeParams.apiUrl — never a
    // process.env read on the invoke path). Use it when in an invoke scope;
    // otherwise fall back to the legacy runner transport env
    // (SOLIDACTIONS_API_URL / APP_URL) so the non-invoke path stays
    // byte-unchanged. Both strip the internal-API suffix to yield the public
    // host signal URLs are served from.
    const scope = getCurrentScope();
    const baseApiUrl = scope
      ? scope.runtimeParams.apiUrl.replace('/api/internal', '')
      : process.env.SOLIDACTIONS_API_URL?.replace('/api/internal', '') ||
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
    // Task 2.6: when a legacy-registered workflow body runs under the one-shot
    // run() path it executes inside invoke()'s ALS scope (not the legacy
    // context store, which is never populated on that path). Read the scope's
    // workflow id FIRST; fall back to the legacy context store when not in an
    // invoke scope so the non-invoke legacy path stays byte-unchanged. This
    // getter is consumed broadly (isWithinWorkflow/isInWorkflow,
    // getSignalUrls, event/message/multistep workflows) — fixing it here
    // resolves several dependent bridges at once.
    return getCurrentScope()?.runtimeParams.workflowID ?? getCurrentContextStore()?.workflowId;
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
    // Task 2.6: mirror the workflowID getter — an active invoke scope means we
    // ARE within a workflow (legacy-API body under the one-shot run() path).
    // Scope-first, then legacy context store (non-invoke path byte-unchanged).
    return getCurrentScope() !== undefined || getCurrentContextStore()?.workflowId !== undefined;
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
   * T2 launcher rework: accept a {@link WorkflowDescriptor} returned by
   * `defineWorkflow` (resolved by registered name) or a bare `string` name
   * (looked up directly in the registry). The legacy `(fn|obj|class).method`
   * signatures remain below. Listed before the generic `<T extends object>`
   * class-target overload so a descriptor / string call matches this signature
   * first (overload resolution is top-to-bottom).
   */
  static startWorkflow<I, O>(
    target: WorkflowDescriptor<I, O>,
    params?: StartWorkflowParams,
  ): (input: I) => Promise<WorkflowHandle<O>>;
  static startWorkflow(
    target: string,
    params?: StartWorkflowParams,
  ): (input: unknown) => Promise<WorkflowHandle<unknown>>;
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
    target: UntypedAsyncFunction | ConfiguredInstance | object | string | WorkflowDescriptor<unknown, unknown>,
    params?: StartWorkflowParams,
  ): unknown {
    // Task 2.7 / T2 launcher rework: invoke-scope bridge (same getCurrentScope()
    // pattern as Task 2.6 send/recv/setEvent). Under one-shot invoke() the
    // legacy ensureSolidActionsIsLaunched + SolidActionsExecutor.globalInstance
    // path does not exist (and would throw "SolidActions.launch() must be
    // called before running workflows"); a child is dispatched via the durable
    // enqueue+suspend bridge instead. The scope check MUST precede
    // ensureSolidActionsIsLaunched. Non-invoke path is byte-unchanged legacy
    // below.
    if (getCurrentScope()) {
      // T2 resolution order (descriptor → string → function w/ registry-first
      // then legacy fallback). Non-callable targets (descriptors / strings)
      // bypass the function-Proxy form entirely: `startWorkflow(desc)(input)`
      // and `startWorkflow('name')(input)` would not be Proxy-callable since
      // their target is not a function (a Proxy is callable iff its target
      // is). The Proxy form below covers function targets + the `.method`
      // shape for objects/classes.

      // (a) WorkflowDescriptor (object with a `run` function — what
      //     `defineWorkflow` returns + stamps with `.name` per T1).
      if (
        target !== null &&
        typeof target === 'object' &&
        typeof (target as WorkflowDescriptor<unknown, unknown>).run === 'function'
      ) {
        const desc = target as WorkflowDescriptor<unknown, unknown>;
        const name = desc.name;
        if (typeof name === 'string' && name.length > 0 && __getRegisteredWorkflow(name)) {
          return invokeStartChildWorkflowByName(name);
        }
        throw SolidActions.#workflowNotRegisteredError(
          typeof name === 'string' && name.length > 0 ? name : '<anonymous-descriptor>',
        );
      }

      // (b) bare string name (look up directly in the registry).
      if (typeof target === 'string') {
        if (__getRegisteredWorkflow(target)) {
          return invokeStartChildWorkflowByName(target);
        }
        throw SolidActions.#workflowNotRegisteredError(target);
      }

      // (c) function / (d) object-with-method — Proxy form. Resolver tries
      //     registry-first (by `.name`), then legacy `getFunctionRegistration`
      //     as the LAST fallback (back-compat with registerWorkflow wrappers).
      return invokeStartChildWorkflow((t, p) => {
        if (p === undefined) {
          // Function target.
          if (typeof t === 'function') {
            const fnName = (t as { name?: string }).name;
            if (fnName && fnName.length > 0 && __getRegisteredWorkflow(fnName)) {
              return fnName;
            }
            const legacy = getFunctionRegistration(t);
            if (legacy) return legacy.name;
            throw SolidActions.#workflowNotRegisteredError(fnName && fnName.length > 0 ? fnName : '<anonymous-fn>');
          }
          // Defensive: a non-function, non-descriptor, non-string target
          // reaching this resolver is a misuse — surface the same error so
          // the AI sees the registered candidates and acts.
          throw SolidActions.#workflowNotRegisteredError(String(t));
        }

        // Object.method path (legacy `startWorkflow(obj).method(args)` form).
        // Registry-first by method-name (works when an object property holds
        // a fn whose registered name equals the prop name), then legacy
        // getFunctionRegistration on the method, then class regOps fallback.
        const propStr = String(p);
        if (__getRegisteredWorkflow(propStr)) {
          return propStr;
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const propVal = Reflect.get(t as object, p);
        if (typeof propVal === 'function') {
          const propFnName = (propVal as { name?: string }).name;
          if (propFnName && propFnName.length > 0 && __getRegisteredWorkflow(propFnName)) {
            return propFnName;
          }
        }
        const regOp =
          getFunctionRegistration(propVal) ?? getRegisteredOperations(target).find((op) => op.name === propStr);
        if (regOp) return regOp.name;
        throw SolidActions.#workflowNotRegisteredError(propStr);
      }, target as object);
    }

    ensureSolidActionsIsLaunched('workflows');
    // Legacy non-invoke path: string / descriptor targets are invoke-only (T2
    // launcher rework). If they reach here, the caller invoked startWorkflow
    // outside an invoke scope — reject with a clear error rather than
    // crashing in Proxy/getRegisteredOperations.
    if (
      typeof target === 'string' ||
      (typeof target === 'object' &&
        target !== null &&
        typeof (target as WorkflowDescriptor<unknown, unknown>).run === 'function' &&
        !(target instanceof ConfiguredInstance))
    ) {
      const ident =
        typeof target === 'string' ? target : ((target as WorkflowDescriptor<unknown, unknown>).name ?? '<descriptor>');
      throw new SolidActionsNotRegisteredError(
        ident,
        `startWorkflow(${ident}) requires an active invoke scope — call inside a workflow body`,
      );
    }
    const legacyTarget = target as UntypedAsyncFunction | ConfiguredInstance | object;
    const instance = typeof legacyTarget === 'function' ? null : (legacyTarget as ConfiguredInstance);
    if (instance && typeof instance !== 'function' && !(instance instanceof ConfiguredInstance)) {
      throw new SolidActionsInvalidWorkflowTransitionError(
        'Attempt to call `startWorkflow` on an object that is not a `ConfiguredInstance`',
      );
    }

    const regOps = getRegisteredOperations(legacyTarget);

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

    return new Proxy(legacyTarget as object, handler);
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
    // Task 2.6: invoke-scope bridge (see setEvent for the rationale). Sender is
    // the invoke-scope workflow id; the `destinationID` from the PUBLIC API is
    // preserved so cross-workflow sends keep working (NOT regressed to the
    // self-send-only ctx primitive). Invoke-ALS function id, not legacy
    // functionIDGetIncrement. Non-invoke path is byte-unchanged legacy below.
    const scope = getCurrentScope();
    if (scope) {
      return scope.executor.send(
        scope.runtimeParams.workflowID,
        nextFunctionID(),
        destinationID,
        SolidActionsJSON.stringify(message),
        topic,
      );
    }

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
    // Task 2.6: invoke-scope bridge (see setEvent for the rationale). Preserves
    // BOTH `topic` and `timeoutSeconds` from the public API and the legacy
    // two-functionID semantics (a function id for the recv and a separate one
    // for the timeout). The ALS-scoped engine is InvokeSystemDatabase, whose
    // recv() POSTs /wait then throws SuspensionRequired (invoke() maps that to
    // { status: 'suspended' } → run() skips terminal writes and exits 0;
    // scheduler resumes on signal/timeout). Invoke-ALS function ids, not legacy
    // functionIDGetIncrement. Non-invoke path is byte-unchanged legacy below.
    //
    // CODEX-FLAG (not masking): a pre-existing backend hazard, NOT fixable in
    // the SDK and NOT fixed here — the backend /wait handler sets the run
    // status to `waiting` (Laravel MessageController.php:265), but the wakeup
    // sweep ProcessScheduledActions.php:124 only re-dispatches runs in
    // `waiting_signal`. So a recv-suspended one-shot run may not be woken by
    // the scheduler. Flag for the Phase-2 e2e gate / a separate backend or
    // harness fix; the SDK-side bridge here is correct (it preserves topic +
    // timeout and suspends properly).
    const scope = getCurrentScope();
    if (scope) {
      const functionID = nextFunctionID();
      const timeoutFunctionID = nextFunctionID();
      const raw = await scope.executor.recv(
        scope.runtimeParams.workflowID,
        functionID,
        timeoutFunctionID,
        topic,
        timeoutSeconds,
      );
      return SolidActionsJSON.parse(raw) as T;
    }

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
    // Task 2.6: a legacy-registered workflow body running under the one-shot
    // run() path executes inside invoke()'s ALS scope (not the legacy
    // executor). Delegate to the ALS-scoped engine with the invoke-scope
    // identity + an invoke-ALS function id (NOT legacy functionIDGetIncrement).
    // ensureSolidActionsIsLaunched() is a legacy-launch guard that does not
    // apply to the invoke() path, so it is intentionally skipped here. When
    // NOT in an invoke scope, behavior is byte-unchanged legacy below.
    const scope = getCurrentScope();
    if (scope) {
      return scope.executor.setEvent(
        scope.runtimeParams.workflowID,
        nextFunctionID(),
        key,
        SolidActionsJSON.stringify(value),
      );
    }

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
    // Task 2.6: invoke-scope bridge (see setEvent for the rationale). respond
    // is NOT a durable checkpoint (no function id, matching the legacy path).
    // The webhook-output PUT MUST be awaited end-to-end before control returns:
    // the backend publishes the Redis wait-mode webhook response INSIDE
    // recordWebhookOutput (Laravel RunStatusController.php:307), so a
    // fire-and-forget would race the one-shot process.exit and drop the
    // caller's response. `await` here + the caller's `await SolidActions.respond`
    // guarantees the PUT completes before run() proceeds to exit. Non-invoke
    // path is byte-unchanged legacy below.
    const scope = getCurrentScope();
    if (scope) {
      await scope.executor.setWebhookOutput(scope.runtimeParams.workflowID, body);
      return;
    }

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
    // T1 launcher rework: the legacy deprecation warning was logged at
    // registration time, which fires on import — this violates the "import
    // is side-effect-free" invariant. Suppress on import; the codemod
    // (T6.2) removes legacy usage. If a deprecation surface is desired
    // later it belongs at SolidActions.run() / runIfEntrypoint() call
    // time, NOT at registration.
    // Task 2.4c (T2 launcher rework): #anonWorkflowSeq retired. The new
    // registry insists on an explicit OR derived name (resolveWorkflowName:
    // config.name > func.name > throw) so anonymous arrows lacking either
    // surface as a clear error at registration instead of being silently
    // labelled `__anon_workflow_<n>`. The legacy callable wrapper +
    // by-unique-name decorator registration are still produced so the
    // legacy executor path / existing call sites keep working unchanged.
    const wfName = resolveWorkflowName(config?.name, func as (...args: never[]) => unknown);
    const registration = wrapSolidActionsFunctionAndRegisterByUniqueName(
      config?.ctorOrProto,
      config?.className,
      wfName,
      wfName,
      func,
    );
    // T1: additionally populate the new invoke registry so T2's
    // startWorkflow child-dispatch can resolve legacy registrations by name.
    // The synthetic descriptor wraps the user function exactly as
    // #toWorkflowDescriptor does for legacy wrappers passed to run() —
    // invoking it routes through the per-request invoke()/ALS scope, not
    // the legacy executor.
    const descriptor: WorkflowDescriptor<unknown, unknown> = {
      run: (ctx) => Promise.resolve((func as unknown as (input: unknown) => Promise<unknown>)(ctx.input)),
      name: wfName,
    };
    registerWorkflowDescriptor(descriptor, wfName);
    return SolidActions.#getWorkflowInvoker(registration, config);
  }

  /**
   * T2 launcher rework: build a {@link WorkflowNotRegisteredError} carrying
   * the supplied identifier AND the sorted list of currently-registered
   * candidate names. Helper for AI debug — the message answers
   * "what was I trying to call, and what could I have called?" in one read.
   */
  static #workflowNotRegisteredError(suppliedIdentifier: string): WorkflowNotRegisteredError {
    const names = __getRegisteredWorkflows()
      .map((d) => d.name ?? '')
      .filter((n) => n.length > 0)
      .sort();
    return new WorkflowNotRegisteredError(suppliedIdentifier, names);
  }

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
