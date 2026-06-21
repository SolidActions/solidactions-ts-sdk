import {} from 'serialize-error';

export function isDataValidationError(e: Error) {
  const solidActionsErrorCode = (e as SolidActionsError)?.solidActionsErrorCode;
  if (!solidActionsErrorCode) return false;
  if (solidActionsErrorCode === DataValidationError) {
    return true;
  }
  return false;
}

export class SolidActionsError extends Error {
  // TODO: define a better coding system.
  constructor(
    msg: string,
    readonly solidActionsErrorCode: number = 1,
  ) {
    super(msg);
  }
}

const InitializationError = 3;
export class SolidActionsInitializationError extends SolidActionsError {
  constructor(
    msg: string,
    readonly error?: Error,
  ) {
    super(msg, InitializationError);
  }
}

const ConflictingWFIDError = 5;
export class SolidActionsWorkflowConflictError extends SolidActionsError {
  constructor(workflowID: string) {
    super(`Conflicting WF ID ${workflowID}`, ConflictingWFIDError);
  }
}

const NotRegisteredError = 6;
export class SolidActionsNotRegisteredError extends SolidActionsError {
  constructor(name: string, fullmsg?: string) {
    const msg = fullmsg ?? `Operation (Name: ${name}) not registered`;
    super(msg, NotRegisteredError);
  }
}

const DataValidationError = 9;
export class SolidActionsDataValidationError extends SolidActionsError {
  constructor(msg: string) {
    super(msg, DataValidationError);
  }
}

const NotAuthorizedError = 12;
export class SolidActionsNotAuthorizedError extends SolidActionsError {
  constructor(
    msg: string,
    readonly status: number = 403,
  ) {
    super(msg, NotAuthorizedError);
  }
}

const ConfigKeyTypeError = 14;
export class SolidActionsConfigKeyTypeError extends SolidActionsError {
  constructor(configKey: string, expectedType: string, actualType: string) {
    super(`${configKey} should be of type ${expectedType}, but got ${actualType}`, ConfigKeyTypeError);
  }
}

const DebuggerError = 15;
export class SolidActionsDebuggerError extends SolidActionsError {
  constructor(msg: string) {
    super('DEBUGGER: ' + msg, DebuggerError);
  }
}

const NonExistentWorkflowError = 16;
export class SolidActionsNonExistentWorkflowError extends SolidActionsError {
  constructor(msg: string) {
    super(msg, NonExistentWorkflowError);
  }
}

const FailLoadOperationsError = 17;
export class SolidActionsFailLoadOperationsError extends SolidActionsError {
  constructor(msg: string) {
    super(msg, FailLoadOperationsError);
  }
}

const MaxRecoveryAttemptsExceededError = 18;
export class SolidActionsMaxRecoveryAttemptsExceededError extends SolidActionsError {
  constructor(workflowID: string, maxRetries: number) {
    super(
      `Workflow ${workflowID} has exceeded its maximum of ${maxRetries} execution or recovery attempts. Further attempts to execute or recover it will fail.`,
      MaxRecoveryAttemptsExceededError,
    );
  }
}

const ExecutorNotInitializedError = 20;
export class SolidActionsExecutorNotInitializedError extends SolidActionsError {
  constructor() {
    super('SolidActions not initialized', ExecutorNotInitializedError);
  }
}

const InvalidWorkflowTransition = 21;
export class SolidActionsInvalidWorkflowTransitionError extends SolidActionsError {
  constructor(msg?: string) {
    super(msg ?? 'Invalid workflow state', InvalidWorkflowTransition);
  }
}

const ConflictingWorkflowError = 22;
export class SolidActionsConflictingWorkflowError extends SolidActionsError {
  constructor(workflowID: string, msg: string) {
    super(`Conflicting workflow invocation with the same ID (${workflowID}): ${msg}`, ConflictingWorkflowError);
  }
}

const MaximumRetriesError = 23;
export class SolidActionsMaxStepRetriesError extends SolidActionsError {
  readonly errors;
  constructor(stepName: string, maxRetries: number, errors: Error[]) {
    const formattedErrors = errors.map((error, index) => `Error ${index + 1}: ${error.message}`).join('. ');
    super(
      `Step ${stepName} has exceeded its maximum of ${maxRetries} retries. Previous errors: ${formattedErrors}`,
      MaximumRetriesError,
    );
    this.errors = errors;
  }
}

const WorkFlowCancelled = 24;
export class SolidActionsWorkflowCancelledError extends SolidActionsError {
  constructor(readonly workflowID: string) {
    super(`Workflow ${workflowID} has been cancelled`, WorkFlowCancelled);
  }
}

const ConflictingRegistrationError = 25;
export class SolidActionsConflictingRegistrationError extends SolidActionsError {
  constructor(msg: string) {
    super(msg, ConflictingRegistrationError);
  }
}

const UnexpectedStep = 26;
/** Exception raised when a step has an unexpected recorded name, indicating a determinism problem. */
export class SolidActionsUnexpectedStepError extends SolidActionsError {
  constructor(
    readonly workflowID: string,
    readonly stepID: number,
    readonly expectedName: string,
    recordedName: string,
  ) {
    super(
      recordedName.startsWith('SolidActions.patch')
        ? `During execution of workflow ${workflowID} step ${stepID}, function ${recordedName} was recorded when ${expectedName} was expected.\n
          Check that your patches are backward compatible, that you do not have older code trying to recover workflows with newer patches, and that your workflow is deterministic.`
        : `During execution of workflow ${workflowID} step ${stepID}, function ${recordedName} was recorded when ${expectedName} was expected. Check that your workflow is deterministic.`,
      UnexpectedStep,
    );
  }
}

const TargetWorkFlowCancelled = 27;
export class SolidActionsAwaitedWorkflowCancelledError extends SolidActionsError {
  constructor(readonly workflowID: string) {
    super(`Awaited ${workflowID} was cancelled`, TargetWorkFlowCancelled);
  }
}

export const QueueDedupIDDuplicated = 28;
/** Exception raised when workflow with same dedupid is queued*/
export class SolidActionsQueueDuplicatedError extends SolidActionsError {
  constructor(
    readonly workflowID: string,
    readonly queue: string,
    readonly deduplicationID: string,
  ) {
    super(
      `Workflow ${workflowID} was deduplicated due to an existing workflow in queue ${queue} with deduplication ID ${deduplicationID}.`,
      QueueDedupIDDuplicated,
    );
  }
}

const InvalidQueuePriority = 29;
/** Exception raised queue priority is invalid */
export class SolidActionsInvalidQueuePriorityError extends SolidActionsError {
  constructor(
    readonly priority: number,
    readonly min: number,
    readonly max: number,
  ) {
    super(`Invalid priority ${priority}. Priority must be between ${min} and ${max}.`, InvalidQueuePriority);
  }
}

export function getSolidActionsErrorCode(e: Error): number | undefined {
  if (e && typeof e === 'object' && 'solidActionsErrorCode' in e) {
    const code = (e as Record<string, unknown>).solidActionsErrorCode;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

// HTTP Error Types
// These errors are thrown when HTTP API calls fail

const HttpErrorCode = 30;

/**
 * Base class for HTTP-related errors
 */
export class SolidActionsHttpError extends SolidActionsError {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly responseBody?: unknown,
  ) {
    super(message, HttpErrorCode);
  }
}

const UnauthorizedErrorCode = 31;

/**
 * Thrown when the API returns 401 Unauthorized
 */
export class SolidActionsUnauthorizedError extends SolidActionsHttpError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401);
    (this as SolidActionsError & { solidActionsErrorCode: number }).solidActionsErrorCode = UnauthorizedErrorCode;
  }
}

const ForbiddenErrorCode = 32;

/**
 * Thrown when the API returns 403 Forbidden
 */
export class SolidActionsForbiddenError extends SolidActionsHttpError {
  constructor(message: string = 'Forbidden') {
    super(message, 403);
    (this as SolidActionsError & { solidActionsErrorCode: number }).solidActionsErrorCode = ForbiddenErrorCode;
  }
}

const NotFoundErrorCode = 33;

/**
 * Thrown when the API returns 404 Not Found
 */
export class SolidActionsNotFoundError extends SolidActionsHttpError {
  constructor(message: string = 'Not found') {
    super(message, 404);
    (this as SolidActionsError & { solidActionsErrorCode: number }).solidActionsErrorCode = NotFoundErrorCode;
  }
}

const RateLimitedErrorCode = 34;

/**
 * Thrown when the API returns 429 Rate Limited
 */
export class SolidActionsRateLimitedError extends SolidActionsHttpError {
  constructor(
    message: string = 'Rate limited',
    readonly retryAfterSeconds?: number,
  ) {
    super(message, 429);
    (this as SolidActionsError & { solidActionsErrorCode: number }).solidActionsErrorCode = RateLimitedErrorCode;
  }
}

const ServerErrorCode = 35;

/**
 * Thrown when the API returns 5xx Server Error
 */
export class SolidActionsServerError extends SolidActionsHttpError {
  constructor(message: string = 'Server error', statusCode: number = 500, responseBody?: unknown) {
    super(message, statusCode, responseBody);
    (this as SolidActionsError & { solidActionsErrorCode: number }).solidActionsErrorCode = ServerErrorCode;
  }
}

const NetworkErrorCode = 36;

/**
 * Thrown when a network error occurs (connection refused, timeout, etc.)
 */
export class SolidActionsNetworkError extends SolidActionsError {
  constructor(message: string = 'Network error') {
    super(message, NetworkErrorCode);
  }
}

const WorkflowAlreadyRegisteredErrorCode = 37;

/**
 * Thrown when two distinct workflow descriptors are registered under the same
 * name in the same process (T1 of the launcher rework). Re-registering the
 * SAME descriptor under the same name is idempotent and does NOT throw.
 */
export class WorkflowAlreadyRegisteredError extends SolidActionsError {
  constructor(readonly workflowName: string) {
    super(
      `Workflow '${workflowName}' is already registered with a different descriptor in this process`,
      WorkflowAlreadyRegisteredErrorCode,
    );
  }
}

const WorkflowNotRegisteredErrorCode = 38;

/**
 * Thrown by T2's invoke-scope `startWorkflow` resolver when the supplied target
 * (a `defineWorkflow` descriptor, a string name, or a function) cannot be
 * resolved to any registry entry AND has no legacy `registerWorkflow`
 * function-registration fallback.
 *
 * The message embeds the supplied identifier AND the sorted list of currently
 * registered candidate names so an AI agent / developer can immediately see
 * what was attempted vs what was available (the most common cause is "the
 * parent forgot to import the child module"). Helper for AI debug.
 */
export class WorkflowNotRegisteredError extends SolidActionsError {
  constructor(
    readonly suppliedIdentifier: string,
    readonly registeredNames: readonly string[],
  ) {
    const candidates = registeredNames.length === 0 ? '[]' : `[${registeredNames.join(', ')}]`;
    super(
      `Workflow '${suppliedIdentifier}' is not registered. Registered: ${candidates}. Did the parent forget to import the child module?`,
      WorkflowNotRegisteredErrorCode,
    );
  }
}

const InvalidContextErrorCode = 39;
/**
 * Thrown when a durable SolidActions primitive (e.g. `now()`, `randomUUID()`)
 * is called outside any recognised workflow execution context (neither
 * invoke-scope ALS nor the legacy executor path is active).
 *
 * @param callerName - The name of the calling function, e.g. `'SolidActions.now'`
 * @param remedy     - Human-readable fix hint shown in the error message
 */
export class SolidActionsInvalidContextError extends SolidActionsError {
  constructor(callerName: string, remedy: string) {
    super(`\`${callerName}\` was called with no active workflow context. ${remedy}`, InvalidContextErrorCode);
    this.name = 'SolidActionsInvalidContextError';
  }
}
