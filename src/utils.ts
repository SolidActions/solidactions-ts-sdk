/**
 * SolidActions SDK Utilities
 *
 * Platform-specific utilities for working with SolidActions workflows.
 * These utilities help with input parsing, environment variables,
 * and other common tasks when running workflows on SolidActions.
 */

import * as fs from 'fs';

// ============================================================================
// Input Helpers
// ============================================================================

/**
 * Get workflow input from environment variable or file
 *
 * SolidActions passes workflow input in two ways:
 * 1. WORKFLOW_INPUT environment variable (JSON string)
 * 2. /app/input.json file inside the container
 *
 * This function tries both sources and returns the parsed input.
 *
 * @typeParam T - The expected type of the input object
 * @returns Parsed input object or null if not available
 *
 * @example
 * ```typescript
 * interface MyInput {
 *   userId: string;
 *   action: string;
 * }
 *
 * const input = getWorkflowInput<MyInput>();
 * if (input) {
 *   console.log(`Processing action ${input.action} for user ${input.userId}`);
 * }
 * ```
 */
export function getWorkflowInput<T = Record<string, unknown>>(): T | null {
  // Try environment variable first (higher priority)
  const envInput = process.env.WORKFLOW_INPUT;
  if (envInput) {
    try {
      return JSON.parse(envInput) as T;
    } catch (error) {
      console.error('[SolidActions SDK] Failed to parse WORKFLOW_INPUT environment variable:', error);
    }
  }

  // Try input file
  const inputFilePath = process.env.WORKFLOW_INPUT_FILE || '/app/input.json';
  try {
    if (fs.existsSync(inputFilePath)) {
      const content = fs.readFileSync(inputFilePath, 'utf8');
      return JSON.parse(content) as T;
    }
  } catch (error) {
    console.error(`[SolidActions SDK] Failed to parse input file ${inputFilePath}:`, error);
  }

  return null;
}

/**
 * Get a specific value from workflow input
 *
 * Convenience function to retrieve a single value from the input object.
 * Supports nested keys using dot notation.
 *
 * @typeParam T - The expected type of the value
 * @param key - The key to look up (supports dot notation for nested values)
 * @param defaultValue - Optional default value if key is not found
 * @returns The value at the specified key or the default value
 *
 * @example
 * ```typescript
 * // Get a simple value
 * const userId = getInputValue<string>('userId');
 *
 * // Get a nested value
 * const email = getInputValue<string>('user.email');
 *
 * // With default value
 * const retries = getInputValue<number>('config.retries', 3);
 * ```
 */
export function getInputValue<T>(key: string, defaultValue?: T): T | undefined {
  const input = getWorkflowInput<Record<string, unknown>>();
  if (!input) {
    return defaultValue;
  }

  // Support dot notation for nested keys
  const keys = key.split('.');
  let value: unknown = input;

  for (const k of keys) {
    if (value === null || value === undefined || typeof value !== 'object') {
      return defaultValue;
    }
    value = (value as Record<string, unknown>)[k];
  }

  if (value === undefined) {
    return defaultValue;
  }

  return value as T;
}

// ============================================================================
// Environment Variable Helpers
// ============================================================================

/**
 * Get an environment variable with optional default
 *
 * @param name - The environment variable name
 * @param defaultValue - Optional default value if not set
 * @returns The environment variable value or default
 *
 * @example
 * ```typescript
 * const apiUrl = getEnvVar('API_URL', 'https://api.default.com');
 * const debugMode = getEnvVar('DEBUG') === 'true';
 * ```
 */
export function getEnvVar(name: string, defaultValue?: string): string | undefined {
  return process.env[name] ?? defaultValue;
}

/**
 * Require an environment variable (throws if not set)
 *
 * Use this for critical configuration that must be present.
 *
 * @param name - The environment variable name
 * @returns The environment variable value
 * @throws Error if the environment variable is not set
 *
 * @example
 * ```typescript
 * const dbUrl = requireEnvVar('DATABASE_URL');
 * // Throws if DATABASE_URL is not set
 * ```
 */
export function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`[SolidActions SDK] Required environment variable ${name} is not set`);
  }
  return value;
}

// ============================================================================
// Run Context Helpers
// ============================================================================

/**
 * Get the current workflow run ID
 *
 * SolidActions sets the STEPS_RUN_ID environment variable for each run.
 *
 * @returns The run ID or 'local' if not running on SolidActions
 */
export function getRunId(): string {
  return process.env.SOLIDACTIONS_RUN_ID || 'local';
}

/**
 * Get the current tenant ID
 *
 * SolidActions sets the TENANT_ID environment variable for tenant context.
 *
 * @returns The tenant ID or undefined if not set
 */
export function getTenantId(): string | undefined {
  return process.env.TENANT_ID;
}

/**
 * Get the SolidActions API URL
 *
 * @returns The API URL or undefined if not set
 */
export function getApiUrl(): string | undefined {
  return process.env.SOLIDACTIONS_API_URL;
}

/**
 * Check if running on SolidActions platform
 *
 * @returns true if running on SolidActions, false if running locally
 */
export function isRunningOnSolidActions(): boolean {
  return process.env.SOLIDACTIONS_RUN_ID !== undefined;
}

// ============================================================================
// Logging Helpers
// ============================================================================

/**
 * Log a message with SolidActions formatting
 *
 * Messages logged with this function will be properly captured
 * in the SolidActions run logs.
 *
 * @param level - Log level (info, warn, error, debug)
 * @param message - The message to log
 * @param data - Optional additional data to include
 */
export function log(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const runId = getRunId();

  const logMessage = {
    timestamp,
    level,
    runId,
    message,
    ...(data !== undefined ? { data } : {}),
  };

  switch (level) {
    case 'error':
      console.error(JSON.stringify(logMessage));
      break;
    case 'warn':
      console.warn(JSON.stringify(logMessage));
      break;
    case 'debug':
      if (process.env.DEBUG === 'true') {
        console.log(JSON.stringify(logMessage));
      }
      break;
    default:
      console.log(JSON.stringify(logMessage));
  }
}

/**
 * Convenience logger object with methods for each log level
 */
export const logger = {
  info: (message: string, data?: unknown) => log('info', message, data),
  warn: (message: string, data?: unknown) => log('warn', message, data),
  error: (message: string, data?: unknown) => log('error', message, data),
  debug: (message: string, data?: unknown) => log('debug', message, data),
};

// ============================================================================
// Retry Helpers
// ============================================================================

/**
 * Backoff strategy for retries
 */
export type BackoffStrategy = 'exponential' | 'linear' | number;

/**
 * Calculate backoff delay for retry attempts
 *
 * @param attempt - The attempt number (1-based)
 * @param backoff - Backoff strategy: 'exponential', 'linear', or fixed number
 * @param base - Base delay in milliseconds
 * @returns Delay in milliseconds
 *
 * @example
 * ```typescript
 * // Exponential: 1000, 2000, 4000, 8000...
 * calculateBackoff(1, 'exponential', 1000); // 1000
 * calculateBackoff(2, 'exponential', 1000); // 2000
 * calculateBackoff(3, 'exponential', 1000); // 4000
 *
 * // Linear: 1000, 2000, 3000, 4000...
 * calculateBackoff(1, 'linear', 1000); // 1000
 * calculateBackoff(2, 'linear', 1000); // 2000
 *
 * // Fixed: always the same
 * calculateBackoff(1, 5000, 1000); // 5000
 * calculateBackoff(2, 5000, 1000); // 5000
 * ```
 */
export function calculateBackoff(
  attempt: number,
  backoff: BackoffStrategy,
  base: number
): number {
  if (typeof backoff === 'number') {
    return backoff;
  }
  if (backoff === 'linear') {
    return base * attempt;
  }
  // Exponential: base * 2^(attempt-1)
  return base * Math.pow(2, attempt - 1);
}

/**
 * Non-durable sleep for use within step.run retry loops
 *
 * This is different from step.sleep which is durable and exits the container.
 * Use this only for short in-memory delays like retry backoff.
 *
 * @param ms - Duration to sleep in milliseconds
 * @returns Promise that resolves after the delay
 */
export function localSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
