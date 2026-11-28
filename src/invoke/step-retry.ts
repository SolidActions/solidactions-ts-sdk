/**
 * The retry loop of a step that sets `retriesAllowed` on the invoke() path.
 * It records nothing: the step primitive records one result after the outcome.
 */
import { SolidActionsMaxStepRetriesError, SolidActionsWorkflowCancelledError } from '../error';
import type { StepConfig } from '../step';
import { sleepms } from '../utils';
import { SuspensionRequired } from './invoke-system-database';
import { runInRetriedStep } from './runtime-scope';

export const MAX_RETRY_INTERVAL_SECONDS = 3600;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INTERVAL_SECONDS = 1;
const DEFAULT_BACKOFF_RATE = 2;

export function capRetryInterval(seconds: number): number {
  return Math.min(seconds, MAX_RETRY_INTERVAL_SECONDS);
}

export function firstRetryInterval(config: StepConfig): number {
  return capRetryInterval(config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
}

export function nextRetryInterval(current: number, config: StepConfig): number {
  return capRetryInterval(current * (config.backoffRate ?? DEFAULT_BACKOFF_RATE));
}

export type RetryOutcome<T> = { ok: true; output: T } | { ok: false; error: SolidActionsMaxStepRetriesError };

export interface RetryOptions {
  stepName: string;
  config: StepConfig;
  /** Runs before every attempt, outside the attempt: what it throws is never retried. */
  beforeAttempt: () => Promise<void>;
  warn: (line: string) => void;
}

/**
 * Run `fn` until it succeeds or `maxAttempts` (total attempts) have failed. The wait between attempts is an
 * in-process timer. A suspension or a cancellation is not a failed attempt and propagates at once.
 */
export async function runWithRetries<T>(fn: () => T | Promise<T>, options: RetryOptions): Promise<RetryOutcome<T>> {
  const { stepName, config, beforeAttempt, warn } = options;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if ((config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) > MAX_RETRY_INTERVAL_SECONDS) {
    warn(`Step config interval exceeds maximum allowed interval, capped to ${MAX_RETRY_INTERVAL_SECONDS} seconds!`);
  }
  let interval = firstRetryInterval(config);
  const errors: Error[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await beforeAttempt();
    try {
      return { ok: true, output: await runInRetriedStep(async () => await fn()) };
    } catch (thrown) {
      if (thrown instanceof SuspensionRequired || thrown instanceof SolidActionsWorkflowCancelledError) {
        throw thrown;
      }
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      errors.push(error);
      warn(`Error in step being automatically retried. Attempt ${attempt} of ${maxAttempts}. ${error.stack}`);
    }
    if (attempt < maxAttempts) {
      await sleepms(interval * 1000);
      interval = nextRetryInterval(interval, config);
    }
  }
  return { ok: false, error: new SolidActionsMaxStepRetriesError(stepName, maxAttempts, errors) };
}
