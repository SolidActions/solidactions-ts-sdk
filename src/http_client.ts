import { GlobalLogger } from './telemetry/logs';
import {
  SolidActionsHttpError,
  SolidActionsUnauthorizedError,
  SolidActionsForbiddenError,
  SolidActionsNotFoundError,
  SolidActionsRateLimitedError,
  SolidActionsServerError,
  SolidActionsNetworkError,
  SolidActionsWorkflowConflictError,
  SolidActionsNonExistentWorkflowError,
  SolidActionsDataValidationError,
} from './error';

export interface HttpClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number; // Default: 30000ms
  maxRetries?: number; // Default: 3
  retryDelay?: number; // Default: 1000ms (base for exponential)
  maxRetryDelay?: number; // Optional cap for exponential backoff (e.g., 60000ms)
  // Worker session id for the X-Worker-Session-ID header. The invoke() path
  // threads this explicitly from ctx.run.workerSessionId; when unset, the
  // legacy boot path falls back to the SOLIDACTIONS_WORKER_SESSION_ID env var.
  workerSessionId?: string;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * HTTP Client for SolidActions SDK with retry logic and error handling.
 *
 * Features:
 * - Exponential backoff with jitter for retries
 * - Only retries on 5xx and network errors (not 4xx)
 * - Respects Retry-After header
 * - Configurable timeout and retry count
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private readonly maxRetryDelay?: number;
  private readonly workerSessionId?: string;
  private logger?: GlobalLogger;

  constructor(config: HttpClientConfig, logger?: GlobalLogger) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
    this.maxRetryDelay = config.maxRetryDelay;
    // Resolve once at construction: explicit (ctx-threaded, invoke path) wins;
    // the SOLIDACTIONS_WORKER_SESSION_ID env var is the legacy boot fallback.
    /* boot-only */ // legacy worker-session transport; invoke() threads ctx.run.workerSessionId via config
    this.workerSessionId = config.workerSessionId ?? process.env.SOLIDACTIONS_WORKER_SESSION_ID;
    this.logger = logger;
  }

  /**
   * Set the logger instance (useful when logger is created after HttpClient)
   */
  setLogger(logger: GlobalLogger): void {
    this.logger = logger;
  }

  /**
   * Make an HTTP request with retry logic
   */
  async request<T>(method: string, path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.executeRequest(method, url, body, options);

        // Success - parse and return response
        if (response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            return (await response.json()) as T;
          }
          // For non-JSON responses, return empty object or text
          const text = await response.text();
          if (text === '') {
            return {} as T;
          }
          try {
            return JSON.parse(text) as T;
          } catch {
            return { data: text } as T;
          }
        }

        // Handle HTTP errors
        const responseBody = await this.parseErrorBody(response);

        // 4xx errors - don't retry, throw immediately
        if (response.status >= 400 && response.status < 500) {
          this.mapHttpErrorToException(response.status, responseBody);
        }

        // 5xx errors - retry with backoff
        if (response.status >= 500) {
          lastError = new SolidActionsServerError(
            responseBody?.message ?? `Server error: ${response.status}`,
            response.status,
            responseBody,
          );

          if (attempt < this.maxRetries) {
            const delay = this.calculateRetryDelay(attempt, response);
            this.logger?.warn(
              `[SolidActions SDK] HTTP request failed with status ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${this.maxRetries})`,
            );
            await this.sleep(delay);
            continue;
          }
          // Max retries exhausted for 5xx - throw the server error
          throw lastError;
        }

        // Unknown error status - throw
        throw new SolidActionsHttpError(
          responseBody?.message ?? `HTTP error: ${response.status}`,
          response.status,
          responseBody,
        );
      } catch (error) {
        // Handle network errors and other exceptions
        if (error instanceof SolidActionsHttpError) {
          throw error; // Re-throw HTTP errors (4xx) immediately
        }

        // Network errors - retry with backoff
        if (this.isNetworkError(error)) {
          lastError = new SolidActionsNetworkError(error instanceof Error ? error.message : 'Network error');

          if (attempt < this.maxRetries) {
            const delay = this.calculateRetryDelay(attempt);
            this.logger?.warn(
              `[SolidActions SDK] Network error, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${this.maxRetries}): ${lastError.message}`,
            );
            await this.sleep(delay);
            continue;
          }
          // Max retries exhausted for network errors - throw the network error
          throw lastError;
        } else {
          // Unknown error type - throw immediately
          throw error;
        }
      }
    }

    // All retries exhausted
    throw lastError ?? new SolidActionsNetworkError('Request failed after all retries');
  }

  /**
   * Convenience methods for common HTTP methods
   */
  async get<T>(path: string, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  async post<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  async put<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, options);
  }

  async delete<T>(path: string, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  async patch<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }

  /**
   * Execute a single HTTP request with timeout
   */
  private async executeRequest(
    method: string,
    url: string,
    body?: unknown,
    options?: HttpRequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options?.headers,
      };

      // Add worker session ID header if available (for linking operations to
      // workers). Resolved once at construction (ctx-threaded on the invoke
      // path; legacy env fallback otherwise) — never a per-request env read.
      if (this.workerSessionId) {
        headers['X-Worker-Session-ID'] = this.workerSessionId;
      }

      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: options?.signal ?? controller.signal,
      };

      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = JSON.stringify(body);
      }

      return await fetch(url, fetchOptions);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Parse error response body
   */
  private async parseErrorBody(response: Response): Promise<{ message?: string; [key: string]: unknown } | undefined> {
    try {
      const text = await response.text();
      if (text) {
        return JSON.parse(text) as { message?: string; [key: string]: unknown };
      }
    } catch {
      // Ignore parse errors
    }
    return undefined;
  }

  /**
   * Map HTTP status codes to appropriate SDK exceptions
   */
  private mapHttpErrorToException(status: number, body?: { message?: string; [key: string]: unknown }): never {
    const message = body?.message ?? `HTTP error ${status}`;

    switch (status) {
      case 400:
        throw new SolidActionsDataValidationError(message);
      case 401:
        throw new SolidActionsUnauthorizedError(message);
      case 403:
        throw new SolidActionsForbiddenError(message);
      case 404:
        // Check if this is a workflow not found error
        if (body?.type === 'workflow_not_found') {
          throw new SolidActionsNonExistentWorkflowError(message);
        }
        throw new SolidActionsNotFoundError(message);
      case 409:
        // Workflow conflict
        throw new SolidActionsWorkflowConflictError((body?.workflowID as string) ?? 'unknown');
      case 429:
        throw new SolidActionsRateLimitedError(message, body?.retryAfter as number);
      default:
        if (status >= 500) {
          throw new SolidActionsServerError(message, status, body);
        }
        throw new SolidActionsHttpError(message, status, body);
    }
  }

  /**
   * Calculate retry delay with exponential backoff and jitter.
   * Formula: delay * 2^attempt + random(0, delay * 0.5)
   *
   * If maxRetryDelay is configured, the delay is capped at that value
   * (with jitter still added). This prevents extremely long delays
   * for high retry counts.
   */
  private calculateRetryDelay(attempt: number, response?: Response): number {
    // Check for Retry-After header
    if (response) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        // Retry-After can be seconds or HTTP date
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          return seconds * 1000;
        }
        // Try parsing as date
        const date = Date.parse(retryAfter);
        if (!isNaN(date)) {
          return Math.max(0, date - Date.now());
        }
      }
    }

    // Exponential backoff with jitter
    const baseDelay = this.retryDelay * Math.pow(2, attempt);
    const jitter = Math.random() * (this.retryDelay * 0.5);
    let delay = baseDelay + jitter;

    // Cap at maxRetryDelay if configured
    if (this.maxRetryDelay && delay > this.maxRetryDelay) {
      delay = this.maxRetryDelay + jitter;
    }

    return delay;
  }

  /**
   * Check if an error is a network error
   */
  private isNetworkError(error: unknown): boolean {
    if (error instanceof TypeError) {
      // fetch throws TypeError for network errors
      return true;
    }
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('network') ||
        message.includes('fetch') ||
        message.includes('econnrefused') ||
        message.includes('enotfound') ||
        message.includes('etimedout') ||
        message.includes('abort')
      );
    }
    return false;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Map HTTP response to SDK error (exported for use elsewhere)
 */
export function mapHttpError(
  status: number,
  body?: { message?: string; type?: string; workflowID?: string; retryAfter?: number; [key: string]: unknown },
): never {
  const message = body?.message ?? `HTTP error ${status}`;

  switch (status) {
    case 400:
      throw new SolidActionsDataValidationError(message);
    case 401:
      throw new SolidActionsUnauthorizedError(message);
    case 403:
      throw new SolidActionsForbiddenError(message);
    case 404:
      if (body?.type === 'workflow_not_found') {
        throw new SolidActionsNonExistentWorkflowError(message);
      }
      throw new SolidActionsNotFoundError(message);
    case 409:
      throw new SolidActionsWorkflowConflictError(body?.workflowID ?? 'unknown');
    case 429:
      throw new SolidActionsRateLimitedError(message, body?.retryAfter);
    default:
      if (status >= 500) {
        throw new SolidActionsServerError(message, status, body);
      }
      throw new SolidActionsHttpError(message, status, body);
  }
}
