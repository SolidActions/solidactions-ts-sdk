# Implementation Plan

**Project**: dbos-http-sdk
**Generated**: 2026-01-10T03:45:00Z

## Technical Context & Standards

_Detected Stack & Patterns_

- **Language**: TypeScript (Node.js >=20)
- **Current DB**: PostgreSQL via `pg@8.11.3`
- **Architecture**: `SystemDatabase` interface with `PostgresSystemDatabase` implementation
- **Serialization**: `superjson` for complex types, JSON for simple types
- **Entry Point**: `src/index.ts` exports main SDK
- **Key Interface**: `SystemDatabase` (lines 64-200 in `src/system_database.ts`)

_Files to Modify/Create_

- `src/system_database.ts` → Create `HttpSystemDatabase` class
- `src/http_client.ts` → New HTTP client with retry logic
- `src/config.ts` → Update configuration for HTTP
- `src/client.ts` → Replace Pool with HTTP client
- `src/dbos-executor.ts` → Update to use HTTP
- `package.json` → Remove `pg`, add HTTP client
- `docs/api-schema.md` → New API documentation

---

## Phase 1: SDK Infrastructure

**Goal**: Create HTTP client infrastructure with retry logic, error handling, and configuration.

---

- [x] **Create HTTP Client with Retry Logic** (ref: PRD Section 4)
      Task ID: `phase-1-infra-01`
  > **Implementation**: Create `src/http_client.ts` > **Details**: Create HTTP client class with:
  >
  > ```typescript
  > export interface HttpClientConfig {
  >   baseUrl: string;
  >   apiKey: string;
  >   timeout?: number; // Default: 30000ms
  >   maxRetries?: number; // Default: 3
  >   retryDelay?: number; // Default: 1000ms (base for exponential)
  > }
  >
  > export class HttpClient {
  >   constructor(config: HttpClientConfig);
  >   async request<T>(method: string, path: string, body?: unknown): Promise<T>;
  >   // Internal: exponential backoff with jitter
  >   // Internal: respect Retry-After header
  > }
  > ```
  >
  > Use native `fetch` (Node.js 18+). Implement:
  >
  > - Exponential backoff: `delay * 2^attempt + random(0, delay * 0.5)`
  > - Only retry on 5xx and network errors
  > - Throw immediately on 4xx
  > - Log retry attempts using `GlobalLogger` from `src/telemetry/logs.ts`

---

- [x] **Create HTTP Error Types** (ref: PRD Section 3)
      Task ID: `phase-1-infra-02`
  > **Implementation**: Add to `src/error.ts` > **Details**: Add new error types that map to HTTP errors:
  >
  > ```typescript
  > export class DBOSHttpError extends DBOSError {
  >   constructor(message: string, public statusCode: number, public responseBody?: unknown);
  > }
  > export class DBOSUnauthorizedError extends DBOSHttpError { /* 401 */ }
  > export class DBOSForbiddenError extends DBOSHttpError { /* 403 */ }
  > export class DBOSNotFoundError extends DBOSHttpError { /* 404 */ }
  > export class DBOSRateLimitedError extends DBOSHttpError { /* 429 */ }
  > export class DBOSServerError extends DBOSHttpError { /* 5xx */ }
  > export class DBOSNetworkError extends DBOSError { /* Network failures */ }
  > ```
  >
  > Existing errors like `DBOSWorkflowConflictError` (line 4) can be thrown for 409.

---

- [x] **Create Error Mapper Function** (ref: PRD Section 3)
      Task ID: `phase-1-infra-03`
  > **Implementation**: Add to `src/http_client.ts` > **Details**: Create function to map HTTP responses to SDK errors:
  >
  > ```typescript
  > export function mapHttpError(response: Response, body?: unknown): never {
  >   switch (response.status) {
  >     case 400: throw new DBOSValidationError(body?.message);
  >     case 401: throw new DBOSUnauthorizedError(...);
  >     case 404: throw new DBOSNonExistentWorkflowError(...); // Reuse existing
  >     case 409: throw new DBOSWorkflowConflictError(...);    // Reuse existing
  >     case 429: throw new DBOSRateLimitedError(...);
  >     default: throw new DBOSServerError(...);
  >   }
  > }
  > ```
  >
  > Map to existing errors where appropriate (lines 4-11 in `src/system_database.ts`).

---

- [x] **Update Configuration for HTTP** (ref: PRD Section 5)
      Task ID: `phase-1-infra-04`
  > **Implementation**: Modify `src/config.ts` > **Details**: Replace database URL config with HTTP config. Update `getSystemDatabaseUrl()` (lines 94-150):
  >
  > ```typescript
  > export interface DBOSHttpConfig {
  >   apiUrl: string; // Required: Base API URL
  >   apiKey: string; // Required: Bearer token
  >   timeout?: number; // Optional: Request timeout
  >   maxRetries?: number; // Optional: Retry count
  > }
  >
  > export function getHttpConfig(configFile?: DBOSConfig): DBOSHttpConfig {
  >   // Read from config or environment variables:
  >   // DBOS_API_URL, DBOS_API_KEY
  > }
  > ```
  >
  > Remove: `getSystemDatabaseUrl()`, `getPGClientConfig()` functions.
  > Keep: Other config functions not related to database.

---

- [x] **Update DBOSConfig Interface** (ref: PRD Section 5)
      Task ID: `phase-1-infra-05`
  > **Implementation**: Modify `src/config.ts` > **Details**: Update the `DBOSConfig` interface to use HTTP config instead of database config:
  >
  > - Remove: `system_database` property with PostgreSQL URL
  > - Add: `api` property with `{ url: string, key: string, timeout?: number }`
  > - Update validation to require `api.url` and `api.key`
  > - Update `loadDBOSConfig()` function to parse new format

---

## Phase 2: Implement HttpSystemDatabase

**Goal**: Create new `HttpSystemDatabase` class implementing the `SystemDatabase` interface using HTTP calls.

---

- [x] **Create HttpSystemDatabase Class Shell** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-01`
  > **Implementation**: Create new class in `src/system_database.ts` (after line 200)
  > **Details**: Create class that implements `SystemDatabase` interface:
  >
  > ```typescript
  > export class HttpSystemDatabase implements SystemDatabase {
  >   private client: HttpClient;
  >   private executorID: string;
  >   private appVersion: string;
  >   private runningWorkflows: Map<string, Promise<unknown>> = new Map();
  >
  >   constructor(config: DBOSHttpConfig, executorID: string, appVersion: string) {
  >     this.client = new HttpClient({
  >       baseUrl: config.apiUrl,
  >       apiKey: config.apiKey,
  >       timeout: config.timeout,
  >       maxRetries: config.maxRetries,
  >     });
  >     this.executorID = executorID;
  >     this.appVersion = appVersion;
  >   }
  > }
  > ```
  >
  > Keep `PostgresSystemDatabase` temporarily for reference, remove in Phase 4.

---

- [x] **Implement init() and destroy()** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-02`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**:
  >
  > ```typescript
  > async init(debugMode?: boolean): Promise<void> {
  >   // HTTP version: Just verify connectivity
  >   await this.client.request('GET', '/health');
  >   // Note: Migrations are Laravel's responsibility
  > }
  >
  > async destroy(): Promise<void> {
  >   // HTTP version: No persistent connections to close
  >   // Just await running workflows
  >   await this.awaitRunningWorkflows();
  > }
  > ```
  >
  > Original PostgresSystemDatabase.init() is at lines 899-911, destroy() at 913-925.

---

- [x] **Implement Workflow Status Methods** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-03`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: Implement these methods using HTTP calls:
  >
  > - `initWorkflowStatus()` → `POST /workflows`
  > - `recordWorkflowOutput()` → `PUT /workflows/{id}/output`
  > - `recordWorkflowError()` → `PUT /workflows/{id}/error`
  > - `getWorkflowStatus()` → `GET /workflows/{id}`
  > - `getPendingWorkflows()` → `GET /workflows/pending?executorId=X&appVersion=Y`
  > - `listWorkflows()` → `GET /workflows?{filters}`
  >
  > Match request/response types to `WorkflowStatusInternal` interface.
  > Original implementations: lines 928-1055 in PostgresSystemDatabase.

---

- [x] **Implement Operation Result Methods** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-04`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: Implement these methods:
  >
  > - `getOperationResultAndThrowIfCancelled()` → `GET /workflows/{id}/operations/{functionId}`
  > - `getAllOperationResults()` → `GET /workflows/{id}/operations`
  > - `recordOperationResult()` → `POST /workflows/{id}/operations`
  >
  > Handle cancelled status: If response indicates cancelled, throw `DBOSWorkflowCancelledError`.
  > Original implementations: lines 1083-1135 in PostgresSystemDatabase.

---

- [x] **Implement awaitWorkflowResult() with Polling** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-05`
  > **Implementation**: Add method to `HttpSystemDatabase` class
  > **Details**: Implement polling-based wait for workflow result:
  >
  > ```typescript
  > async awaitWorkflowResult(
  >   workflowID: string,
  >   timeoutSeconds?: number,
  >   callerID?: string,
  >   timerFuncID?: number,
  > ): Promise<SystemDatabaseStoredResult | undefined> {
  >   const deadline = timeoutSeconds ? Date.now() + timeoutSeconds * 1000 : undefined;
  >   const pollInterval = 1000; // 1 second
  >
  >   while (!deadline || Date.now() < deadline) {
  >     const result = await this.client.request('GET', `/workflows/${workflowID}/result`);
  >     if (result.status !== 'PENDING') return result;
  >     await sleepms(pollInterval);
  >   }
  >   return undefined; // Timeout
  > }
  > ```
  >
  > Original PostgreSQL version uses LISTEN/NOTIFY (lines 1817-1905). HTTP version uses polling.

---

- [x] **Implement Workflow Control Methods** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-06`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: Implement these methods:
  >
  > - `setWorkflowStatus()` → `PUT /workflows/{id}/status`
  > - `cancelWorkflow()` → `POST /workflows/{id}/cancel`
  > - `resumeWorkflow()` → `POST /workflows/{id}/resume`
  > - `forkWorkflow()` → `POST /workflows/{id}/fork`
  > - `checkIfCanceled()` → `GET /workflows/{id}/cancelled`
  >
  > Original implementations: lines 1657-1769 in PostgresSystemDatabase.

---

- [x] **Implement Running Workflow Tracking** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-07`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: These are in-memory operations (no HTTP needed):
  >
  > ```typescript
  > registerRunningWorkflow(workflowID: string, workflowPromise: Promise<unknown>): void {
  >   this.runningWorkflows.set(workflowID, workflowPromise);
  >   workflowPromise.finally(() => this.runningWorkflows.delete(workflowID));
  > }
  >
  > checkForRunningWorkflow(workflowID: string): boolean {
  >   return this.runningWorkflows.has(workflowID);
  > }
  >
  > async awaitRunningWorkflows(): Promise<void> {
  >   await Promise.allSettled(this.runningWorkflows.values());
  > }
  > ```
  >
  > Same logic as PostgresSystemDatabase (in-memory tracking).

---

- [x] **Implement Queue Methods** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-08`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: Implement these methods:
  >
  > - `clearQueueAssignment()` → `DELETE /workflows/{id}/queue-assignment`
  > - `getDeduplicatedWorkflow()` → `GET /queues/{name}/deduplicated/{dedupId}`
  > - `getQueuePartitions()` → `GET /queues/{name}/partitions`
  > - `findAndMarkStartableWorkflows()` → `POST /queues/{name}/start-workflows`
  >
  > Original implementations: lines 2134-2320 in PostgresSystemDatabase.
  > Note: `findAndMarkStartableWorkflows` is complex with REPEATABLE READ - Laravel handles atomicity.

---

- [x] **Implement Messaging Methods (send/recv/sleep)** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-09`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: Implement these methods:
  >
  > - `send()` → `POST /workflows/{id}/messages`
  > - `recv()` → `GET /workflows/{id}/messages?topic=X` (with polling loop)
  > - `durableSleepms()` → `POST /workflows/{id}/sleep`
  >
  > For `recv()`, implement polling similar to `awaitWorkflowResult()`:
  >
  > ```typescript
  > async recv(workflowID, functionID, timeoutFunctionID, topic?, timeoutSeconds?): Promise<string | null> {
  >   const deadline = timeoutSeconds ? Date.now() + timeoutSeconds * 1000 : undefined;
  >   while (!deadline || Date.now() < deadline) {
  >     // Check if cancelled first
  >     await this.checkIfCanceled(workflowID);
  >     const result = await this.client.request('GET', `/workflows/${workflowID}/messages?topic=${topic}`);
  >     if (result.message !== null) return result.message;
  >     await sleepms(1000);
  >   }
  >   return null;
  > }
  > ```
  >
  > Original implementations: lines 1242-1480 in PostgresSystemDatabase.

---

- [x] **Implement Event Methods** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-10`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: Implement these methods:
  >
  > - `setEvent()` → `PUT /workflows/{id}/events/{key}`
  > - `getEvent()` → `GET /workflows/{id}/events/{key}` (with polling loop)
  >
  > For `getEvent()`, implement polling similar to `recv()`.
  > Original implementations: lines 1501-1656 in PostgresSystemDatabase.

---

- [x] **Implement Event Dispatch State Methods** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-11`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: Implement these methods:
  >
  > - `getEventDispatchState()` → `GET /event-dispatch/{service}/{workflowFnName}/{key}`
  > - `upsertEventDispatchState()` → `PUT /event-dispatch`
  >
  > Preserve versioning semantics (update_time, update_seq) in request/response.
  > Original implementations: lines 1959-2014 in PostgresSystemDatabase.

---

- [x] **Implement Streaming Methods** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-12`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: Implement these methods:
  >
  > - `writeStreamFromWorkflow()` → `POST /workflows/{id}/streams/{key}` with `{fromWorkflow: true, functionId}`
  > - `writeStreamFromStep()` → `POST /workflows/{id}/streams/{key}` with `{fromWorkflow: false}`
  > - `closeStream()` → `POST /workflows/{id}/streams/{key}/close`
  > - `readStream()` → `GET /workflows/{id}/streams/{key}/{offset}`
  >
  > Handle `DBOS_STREAM_CLOSED_SENTINEL` in responses.
  > Original implementations: lines 2321-2425 in PostgresSystemDatabase.

---

- [x] **Implement Admin Methods** (ref: PRD Section 1)
      Task ID: `phase-2-http-db-13`
  > **Implementation**: Add methods to `HttpSystemDatabase` class
  > **Details**: Implement these methods:
  >
  > - `garbageCollect()` → `POST /admin/garbage-collect`
  > - `getMetrics()` → `GET /admin/metrics?startTime=X&endTime=Y`
  > - `checkPatch()` → `GET /workflows/{id}/patch/{functionId}?patchName=X&deprecated=Y`
  >
  > Original implementations: lines 2427-2543 in PostgresSystemDatabase.

---

## Phase 3: Integration & Cleanup

**Goal**: Wire up new HttpSystemDatabase, remove PostgreSQL dependencies.

---

- [x] **Update DBOSExecutor to use HttpSystemDatabase** (ref: PRD Section 1)
      Task ID: `phase-3-integration-01`
  > **Implementation**: Modify `src/dbos-executor.ts` > **Details**: Update DBOSExecutor class:
  >
  > - Line 80: Remove `import { Pool } from 'pg';`
  > - Update constructor to accept `DBOSHttpConfig` instead of database URL
  > - Create `HttpSystemDatabase` instead of `PostgresSystemDatabase`
  > - Remove any direct Pool usage
  >
  > Look for all `Pool` references and replace with HTTP client usage.

---

- [x] **Update DBOSClient to use HTTP** (ref: PRD Section 1)
      Task ID: `phase-3-integration-02`
  > **Implementation**: Modify `src/client.ts` > **Details**: Update DBOSClient class:
  >
  > - Line 31: Remove `import { Pool } from 'pg';`
  > - Update constructor to use `HttpSystemDatabase` or `HttpClient` directly
  > - Update all methods that query workflow status to use HTTP
  > - Remove Pool member variable and initialization
  >
  > The client uses Pool for `listWorkflows()`, `getWorkflow()`, etc.

---

- [x] **Remove database_utils.ts PostgreSQL Functions** (ref: PRD Section 1)
      Task ID: `phase-3-integration-03`
  > **Implementation**: Modify `src/database_utils.ts` > **Details**:
  >
  > - Remove or deprecate functions that are PostgreSQL-specific:
  >   - `dropPGDatabase()` (lines 40-177)
  >   - `ensurePGDatabase()` (lines 207-326)
  >   - `connectToPGDatabase()` (lines 377-394)
  >   - `connectToPGAndReportOutcome()` (lines 396-416)
  >   - `currentDBUserIdentity()` (lines 423-430)
  >   - `getPGDatabaseOwner()` (lines 432-440)
  >   - `grantDbosSchemaPermissions()` (lines 253-303)
  > - Keep utility functions not tied to PostgreSQL if any exist
  > - Consider renaming file to `http_utils.ts` if it has remaining content

---

- [x] **Update CLI to use HTTP** (ref: PRD Section 1)
      Task ID: `phase-3-integration-04`
  > **Implementation**: Modify `src/cli/cli.ts` > **Details**: Update CLI commands that interact with database:
  >
  > - Commands that list/query workflows should use HTTP client
  > - Remove direct database connection logic
  > - Update `docker_pg_helper.ts` - either remove entirely or keep for local development with note that it's for Laravel's database, not SDK's

---

- [x] **Remove PostgresSystemDatabase Class** (ref: PRD Section 1)
      Task ID: `phase-3-integration-05`
  > **Implementation**: Modify `src/system_database.ts` > **Details**:
  >
  > - Remove the entire `PostgresSystemDatabase` class (lines 830-2554)
  > - Remove helper functions that were only used by PostgresSystemDatabase:
  >   - `insertWorkflowStatus()` (lines 400-517)
  >   - `updateWorkflowStatus()` (lines 512-596)
  >   - `recordOperationResult()` helper (lines 598-767)
  > - Keep the `SystemDatabase` interface (lines 64-200)
  > - Keep `HttpSystemDatabase` as the only implementation
  > - Remove `import { ... } from 'pg';` at line 2

---

- [x] **Remove Migration Runner** (ref: PRD Section 1)
      Task ID: `phase-3-integration-06`
  > **Implementation**: Remove/deprecate `src/sysdb_migrations/` > **Details**:
  >
  > - Remove or deprecate `src/sysdb_migrations/migration_runner.ts`
  > - Remove or deprecate `src/sysdb_migrations/internal/migrations.ts`
  > - Migrations are now Laravel's responsibility
  > - Document in API schema that Laravel must set up the database schema

---

- [x] **Update package.json Dependencies** (ref: PRD Section 4)
      Task ID: `phase-3-integration-07`
  > **Implementation**: Modify `package.json` > **Details**:
  > Remove from `dependencies`:
  >
  > ```json
  > - "pg": "8.11.3"
  > ```
  >
  > Remove from `devDependencies`:
  >
  > ```json
  > - "@types/pg": "^8.11.2"
  > - "@testcontainers/postgresql": "^11.6.0"
  > ```
  >
  > Note: No new HTTP client dependency needed if using native `fetch` (Node.js 18+).

---

- [x] **Update Index Exports** (ref: PRD Section 1)
      Task ID: `phase-3-integration-08`
  > **Implementation**: Modify `src/index.ts` > **Details**:
  >
  > - Export `HttpSystemDatabase` instead of `PostgresSystemDatabase`
  > - Export new error types (`DBOSHttpError`, etc.)
  > - Export `HttpClient` and `HttpClientConfig` for advanced usage
  > - Remove any PostgreSQL-specific exports

---

## Phase 4: API Schema Documentation

**Goal**: Document all HTTP endpoints based on the implemented HttpSystemDatabase for Laravel to implement.

---

- [x] **Create API Schema Documentation** (ref: PRD Section 2)
      Task ID: `phase-4-api-docs-01`
  > **Implementation**: Create `docs/api-schema.md` > **Details**: Document all HTTP endpoints based on actual implementation:
  >
  > - Base URL and authentication header format
  > - All endpoints organized by category (workflows, operations, queues, messaging, events, streams, admin)
  > - Request/response JSON schemas derived from TypeScript interfaces
  > - HTTP status codes and their meanings
  > - Atomicity requirements (mark which endpoints must be transactional)
  > - Polling endpoints (recv, getEvent, awaitWorkflowResult) with recommended intervals

---

- [x] **Document Database Schema for Laravel** (ref: PRD Section 2)
      Task ID: `phase-4-api-docs-02`
  > **Implementation**: Add to `docs/api-schema.md` > **Details**: Include database schema documentation for Laravel:
  >
  > - All tables from `schemas/system_db_schema.ts`
  > - Indexes required for performance
  > - Foreign key relationships
  > - Note: Laravel owns migrations, but needs to know the schema

---

## Phase 5: Validation & Documentation

**Goal**: Ensure everything works, update tests, create documentation.

---

- [x] **Update Unit Tests for HTTP** (ref: PRD Section 4)
      Task ID: `phase-5-validation-01`
  > **Implementation**: Modify test files in `tests/` > **Details**:
  >
  > - Replace PostgreSQL test containers with HTTP mocking
  > - Use `jest.mock()` or similar to mock `fetch` calls
  > - Create mock HTTP responses for all endpoints
  > - Ensure all existing test cases pass with HTTP mocks
  > - Test retry logic with simulated 5xx errors
  > - Test error mapping with simulated 4xx errors

---

- [x] **Create HTTP Integration Tests** (ref: PRD Section 4)
      Task ID: `phase-5-validation-02`
  > **Implementation**: Create `tests/http_integration.test.ts` > **Details**:
  >
  > - Create integration tests that test against a real HTTP server
  > - Can use a mock server or wait for Laravel implementation
  > - Test full workflow lifecycle over HTTP
  > - Test error scenarios

---

- [x] **Create Migration Guide Document** (ref: PRD Deliverables)
      Task ID: `phase-5-validation-03`
  > **Implementation**: Create `docs/migration-guide.md` > **Details**: Document for users:
  >
  > - Configuration changes (database URL → API URL + key)
  > - Environment variable changes (`PGHOST` → `DBOS_API_URL`)
  > - Breaking changes list
  > - Example new configuration
  > - Step-by-step migration instructions

---

- [x] **Document Removed Dependencies** (ref: PRD Deliverables)
      Task ID: `phase-5-validation-04`
  > **Implementation**: Add section to `docs/migration-guide.md` > **Details**: List all removed packages:
  >
  > - `pg@8.11.3`
  > - `@types/pg@^8.11.2`
  > - `@testcontainers/postgresql@^11.6.0`
  >
  > Explain implications for users who may have been using these.

---

- [x] **Update README** (ref: PRD Deliverables)
      Task ID: `phase-5-validation-05`
  > **Implementation**: Modify `README.md` > **Details**:
  >
  > - Update installation instructions
  > - Update configuration examples to show API URL + key
  > - Remove PostgreSQL setup instructions
  > - Add link to Laravel API requirements
  > - Update architecture diagram if present

---

- [x] **Final Verification: Run All Tests** (ref: PRD Success Criteria)
      Task ID: `phase-5-validation-06`
  > **Implementation**: Run `npm test` > **Details**:
  >
  > - Ensure all unit tests pass
  > - Ensure no TypeScript errors (`npm run build`)
  > - Ensure no lint errors (`npm run lint`)
  > - Verify package can be published (`npm pack --dry-run`)

---

## Summary

| Phase     | Tasks  | Focus                                              |
| --------- | ------ | -------------------------------------------------- |
| Phase 1   | 5      | SDK Infrastructure (HTTP client, errors, config)   |
| Phase 2   | 13     | Implement HttpSystemDatabase                       |
| Phase 3   | 8      | Integration & Cleanup                              |
| Phase 4   | 2      | API Schema Documentation (based on implementation) |
| Phase 5   | 6      | Validation & Documentation                         |
| **Total** | **34** |                                                    |

---

_Generated by Clavix /clavix:plan_
