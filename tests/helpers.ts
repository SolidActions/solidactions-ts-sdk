/**
 * Test Helpers for SolidActions SDK
 *
 * Updated to support HTTP-based testing with mock server.
 */

import { SolidActionsConfig, SolidActionsExecutor } from '../src/solidactions-executor';
import { SolidActions, StatusString } from '../src';
import { sleepms } from '../src/utils';
import { HttpSystemDatabase } from '../src/system_database';
import { GlobalLogger } from '../src/telemetry/logs';
import { MockHttpServer, createMockServer } from './http_mock_server';

// Global mock server instance for tests
let globalMockServer: MockHttpServer | null = null;

/**
 * Generate HTTP-based test config
 * Uses a mock HTTP server instead of PostgreSQL
 * Note: Synchronous version - requires setUpSolidActionsTestServer() to be called first
 */
export function generateSolidActionsTestConfig(): SolidActionsConfig {
  if (!globalMockServer) {
    throw new Error('Mock server not initialized. Call setUpSolidActionsTestServer() first.');
  }

  return {
    name: 'solidactionstest',
    api: {
      url: globalMockServer.baseUrl,
      key: 'test-api-key',
      timeout: 5000,
      maxRetries: 1,
    },
  };
}

/**
 * Generate HTTP-based test config (async version)
 * Automatically starts mock server if needed
 */
export async function generateSolidActionsTestConfigAsync(): Promise<SolidActionsConfig> {
  if (!globalMockServer) {
    await setUpSolidActionsTestServer();
  }
  return generateSolidActionsTestConfig();
}

/**
 * Generate HTTP config for direct use with HttpSystemDatabase
 */
export function generateHttpTestConfig() {
  if (!globalMockServer) {
    throw new Error('Mock server not initialized. Call setUpSolidActionsTestServer() first.');
  }

  return {
    apiUrl: globalMockServer.baseUrl,
    apiKey: 'test-api-key',
    timeout: 5000,
    maxRetries: 1,
  };
}

/**
 * Set up mock HTTP server for testing
 * Call this in beforeAll()
 */
export async function setUpSolidActionsTestServer(): Promise<MockHttpServer> {
  if (!globalMockServer) {
    globalMockServer = await createMockServer();
  }
  return globalMockServer;
}

/**
 * Tear down mock HTTP server
 * Call this in afterAll()
 */
export async function tearDownSolidActionsTestServer(): Promise<void> {
  if (globalMockServer) {
    await globalMockServer.stop();
    globalMockServer = null;
  }
}

/**
 * Clear mock server state between tests
 * Call this in beforeEach()
 */
export function clearMockServerState(): void {
  if (globalMockServer) {
    globalMockServer.store.clear();
    globalMockServer.requestLog.length = 0;
  }
}

/**
 * Get the global mock server instance
 */
export function getMockServer(): MockHttpServer | null {
  return globalMockServer;
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use setUpSolidActionsTestServer() instead
 */
export async function setUpSolidActionsTestSysDb(config: SolidActionsConfig): Promise<void> {
  // For HTTP-based tests, just ensure server is running
  await setUpSolidActionsTestServer();
}

// A helper class for testing concurrency. Behaves similarly to threading.Event in Python.
// The class contains a promise and a resolution.
// Await Event.wait() to await the promise.
// Call event.set() to resolve the promise.
export class Event {
  private _resolve: (() => void) | null = null;
  private _promise: Promise<void>;

  constructor() {
    this._promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  set(): void {
    if (this._resolve) {
      this._resolve();
      this._resolve = null;
    }
  }

  wait(): Promise<void> {
    return this._promise;
  }

  clear(): void {
    this._promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }
}

export async function queueEntriesAreCleanedUp() {
  let maxTries = 10;
  let success = false;
  while (maxTries > 0) {
    // Check for ENQUEUED workflows (which represent queued items)
    const qtasks = await SolidActions.listWorkflows({ status: StatusString.ENQUEUED });
    if (qtasks.length === 0) {
      success = true;
      break;
    }
    await sleepms(1000);
    --maxTries;
  }
  return success;
}

// copied from https://github.com/uuidjs/uuid project
export function uuidValidate(uuid: string) {
  const regex =
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
  return regex.test(uuid);
}

export function recoverPendingWorkflows(executorIDs: string[] = ['local']) {
  expect(SolidActionsExecutor.globalInstance).toBeDefined();
  return SolidActionsExecutor.globalInstance!.recoverPendingWorkflows(executorIDs);
}

export function executeWorkflowById(workflowId: string) {
  expect(SolidActionsExecutor.globalInstance).toBeDefined();
  return SolidActionsExecutor.globalInstance!.executeWorkflowId(workflowId);
}

export async function setWfAndChildrenToPending(workflowId: string, resetRecoveryAttempts: boolean = true) {
  const wfl = await SolidActions.listWorkflows({ workflow_id_prefix: workflowId });
  for (const wf of wfl) {
    await SolidActionsExecutor.globalInstance?.systemDatabase.setWorkflowStatus(
      wf.workflowID,
      StatusString.PENDING,
      resetRecoveryAttempts,
    );
  }
}

export async function reexecuteWorkflowById(
  workflowId: string,
  resetRecoveryAttempts: boolean = true,
  _updateName?: string,
) {
  expect(SolidActionsExecutor.globalInstance).toBeDefined();
  await SolidActionsExecutor.globalInstance?.systemDatabase.setWorkflowStatus(
    workflowId,
    StatusString.PENDING,
    resetRecoveryAttempts,
  );
  return await SolidActionsExecutor.globalInstance?.executeWorkflowId(workflowId, { isRecoveryDispatch: true });
}

/**
 * @deprecated PostgreSQL-specific function removed in HTTP SDK
 */
export async function dropDatabase(_connectionString: string, _database?: string): Promise<void> {
  // No-op for HTTP-based tests
  console.warn('dropDatabase() is deprecated in HTTP SDK - no database to drop');
}

/**
 * @deprecated PostgreSQL-specific function removed in HTTP SDK
 */
export async function causeChaos(_db: string): Promise<void> {
  // No-op for HTTP-based tests
  console.warn('causeChaos() is deprecated in HTTP SDK');
}
