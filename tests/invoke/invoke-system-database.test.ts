/**
 * Tests for InvokeSystemDatabase.
 *
 * Verifies that durableSleepms and recv:
 *   1. POST the schedule/wait to the mock server (observable via requestLog)
 *   2. Throw SuspensionRequired instead of calling process.exit
 */

import { InvokeSystemDatabase, SuspensionRequired } from '../../src/invoke/invoke-system-database';
import { setUpSolidActionsTestServer, clearMockServerState } from '../helpers';
import { SolidActionsJSON } from '../../src/serialization';
import { GlobalLogger } from '../../src/telemetry/logs';
import { expectProcessExit, ProcessExitSignal } from './helpers-exit';

describe('InvokeSystemDatabase', () => {
  beforeAll(async () => {
    await setUpSolidActionsTestServer();
  });

  beforeEach(() => {
    clearMockServerState();
  });

  it('durableSleepms posts the sleep schedule then throws SuspensionRequired (no process.exit)', async () => {
    const srv = await setUpSolidActionsTestServer();
    const logger = new GlobalLogger();
    const db = new InvokeSystemDatabase(
      { apiUrl: srv.baseUrl, apiKey: 'test-api-key', timeout: 5000, maxRetries: 1 },
      { executorID: 'r1', appVersion: 'v0' },
      logger,
      SolidActionsJSON,
    );

    // Must throw SuspensionRequired, not process.exit
    await expect(db.durableSleepms('wf-sleep-1', 1, 1000)).rejects.toBeInstanceOf(SuspensionRequired);

    // The thrown error must carry reason='sleep'
    const err = await db.durableSleepms('wf-sleep-2', 1, 500).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SuspensionRequired);
    expect((err as SuspensionRequired).reason).toBe('sleep');

    // A sleep POST must have hit the mock server for wf-sleep-1
    const sleepPost = srv.requestLog.find(
      (r) => r.method === 'POST' && r.path.includes('wf-sleep-1') && r.path.endsWith('/sleep'),
    );
    expect(sleepPost).toBeDefined();
  });

  it('recv posts wait then throws SuspensionRequired (no process.exit)', async () => {
    const srv = await setUpSolidActionsTestServer();
    const logger = new GlobalLogger();
    const db = new InvokeSystemDatabase(
      { apiUrl: srv.baseUrl, apiKey: 'test-api-key', timeout: 5000, maxRetries: 1 },
      { executorID: 'r1', appVersion: 'v0' },
      logger,
      SolidActionsJSON,
    );

    await expect(db.recv('wf-recv-1', 1, 0, undefined, undefined)).rejects.toBeInstanceOf(SuspensionRequired);

    const err = await db.recv('wf-recv-2', 1, 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SuspensionRequired);
    expect((err as SuspensionRequired).reason).toBe('recv');

    // A wait POST must have hit the mock server for wf-recv-1
    const waitPost = srv.requestLog.find(
      (r) => r.method === 'POST' && r.path.includes('wf-recv-1') && r.path.endsWith('/wait'),
    );
    expect(waitPost).toBeDefined();
  });

  it('SuspensionRequired is an Error subclass with the expected reason field', () => {
    const sleepErr = new SuspensionRequired('sleep');
    expect(sleepErr).toBeInstanceOf(Error);
    expect(sleepErr).toBeInstanceOf(SuspensionRequired);
    expect(sleepErr.reason).toBe('sleep');
    expect(sleepErr.message).toContain('sleep');

    const recvErr = new SuspensionRequired('recv');
    expect(recvErr.reason).toBe('recv');
  });

  it('durableSleepms does NOT call process.exit — rejects with SuspensionRequired, not ProcessExitSignal', async () => {
    const srv = await setUpSolidActionsTestServer();
    const logger = new GlobalLogger();
    const db = new InvokeSystemDatabase(
      { apiUrl: srv.baseUrl, apiKey: 'test-api-key', timeout: 5000, maxRetries: 1 },
      { executorID: 'r1', appVersion: 'v0' },
      logger,
      SolidActionsJSON,
    );

    // Arm the process.exit interceptor. If the code calls process.exit the interceptor
    // will throw ProcessExitSignal instead. We then assert that the error is
    // SuspensionRequired (not ProcessExitSignal), proving process.exit was NOT called.
    let caughtError: unknown;
    try {
      await expectProcessExit(() => db.durableSleepms('wf-no-exit-sleep', 1, 100));
      // expectProcessExit throws if process.exit was never called, which means we
      // would only reach here if it did NOT throw — meaning process.exit was not
      // called (the function completed without it). We'll assert separately below.
    } catch (err) {
      caughtError = err;
    }

    // The code path must have thrown SuspensionRequired, not ProcessExitSignal.
    // If process.exit had been called, `expectProcessExit` would have returned a number
    // (the exit code) without ever reaching the catch here, and caughtError would be
    // undefined. But durableSleepms rejects with SuspensionRequired — expectProcessExit
    // re-throws that because it's not a ProcessExitSignal — so caughtError is set.
    expect(caughtError).toBeInstanceOf(SuspensionRequired);
    expect(caughtError).not.toBeInstanceOf(ProcessExitSignal);
  });

  it('recv does NOT call process.exit — rejects with SuspensionRequired, not ProcessExitSignal', async () => {
    const srv = await setUpSolidActionsTestServer();
    const logger = new GlobalLogger();
    const db = new InvokeSystemDatabase(
      { apiUrl: srv.baseUrl, apiKey: 'test-api-key', timeout: 5000, maxRetries: 1 },
      { executorID: 'r1', appVersion: 'v0' },
      logger,
      SolidActionsJSON,
    );

    let caughtError: unknown;
    try {
      await expectProcessExit(() => db.recv('wf-no-exit-recv', 1, 0));
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(SuspensionRequired);
    expect(caughtError).not.toBeInstanceOf(ProcessExitSignal);
  });
});
