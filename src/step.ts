/**
 * Configuration options for a `SolidActions.step` function
 */
export interface StepConfig {
  /** If `true`, the step is retried if it throws (default false) */
  retriesAllowed?: boolean;
  /** Seconds to wait before the first retry (default 1, at most 3600) */
  intervalSeconds?: number;
  /** If `retriesAllowed` is true: total attempts, including the first (default 3) */
  maxAttempts?: number;
  /** If `retriesAllowed` is true: the multiplier of the wait after each retry (default 2, each wait at most 3600 seconds) */
  backoffRate?: number;
  /** If specified, override step function name */
  name?: string;
}
