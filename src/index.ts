// Main exports - SolidActions SDK
export { SolidActions } from './solidactions';

export { SolidActionsClient } from './client';

export {
  ArgDataType,
  SolidActionsDataType,
  SolidActionsLifecycleCallback,
  SolidActionsMethodMiddlewareInstaller,
  ExternalRegistration,
  MethodRegistrationBase,
  ArgName,
} from './decorators';

export * as Error from './error';

export { SolidActionsWorkflowConflictError } from './error';

export { WorkflowConfig, WorkflowHandle, StatusString, GetWorkflowsInput, WorkflowStatus } from './workflow';

export { SerializationRecipe, SolidActionsSerializer } from './serialization';

export { StepConfig } from './step';

export { FunctionName, ConfiguredInstance, MethodParameter } from './decorators';

// Config exports
export {
  SolidActionsConfig,
  SolidActionsConfigInternal,
  SolidActionsRuntimeConfig,
  SolidActionsExecutor,
  SolidActionsExternalState,
} from './solidactions-executor';

export { SolidActionsHttpConfig, getHttpConfig, SolidStepsConfig, readSolidStepsConfig } from './config';

export { HttpSystemDatabase, SystemDatabase } from './system_database';

export { HttpClient, HttpClientConfig } from './http_client';

// New contract: defineWorkflow + public types (T8 — package root export)
export { defineWorkflow } from './invoke/define-workflow';

export type {
  // Context passed to every workflow's run() function
  InvokeCtx,
  InvokeCtxRun,
  InvokeCtxApp,
  // Return value from invoke()
  InvokeResult,
  // The descriptor returned by / accepted by defineWorkflow
  WorkflowDescriptor,
  // Supporting types a user-facing type-annotation would reference
  DurablePrimitives,
  ConnectionVar,
  VarValue,
  // Augmentation hook — generated .d.ts files extend this interface
  // via `declare module '@solidactions/sdk' { interface InvokeCtxVarsAugment { ... } }`
  InvokeCtxVarsAugment,
} from './invoke/types';

// Errors a user may catch at runtime
export { WorkflowAlreadyRegisteredError, WorkflowNotRegisteredError } from './error';
