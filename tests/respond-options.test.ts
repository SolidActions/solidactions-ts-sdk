/**
 * Tests for setWebhookOutput options (status + headers) extension.
 * Uses Jest globals — no vitest imports needed.
 */

import { HttpSystemDatabase } from '../src/http_system_database';
import { createMockServer, MockHttpServer } from '../src/testing/mock_server';
import { GlobalLogger } from '../src/telemetry/logs';
import { SolidActionsJSON } from '../src/serialization';

describe('setWebhookOutput with options', () => {
  let mockServer: MockHttpServer;
  let sysDb: HttpSystemDatabase;

  beforeAll(async () => {
    mockServer = await createMockServer();
    sysDb = new HttpSystemDatabase(
      {
        apiUrl: mockServer.baseUrl,
        apiKey: 'test-key',
        timeout: 5000,
        maxRetries: 1,
      },
      'test-executor',
      '1.0.0',
      new GlobalLogger(),
      SolidActionsJSON,
    );
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.store.clear();
    mockServer.requestLog.length = 0;
  });

  it('sends status and headers in the PUT body', async () => {
    await sysDb.setWebhookOutput('wf-123', { result: 'ok' }, { status: 201, headers: { 'X-Request-Id': 'abc' } });

    // The mock server logs every request before routing (mock_server.ts:196)
    const entry = mockServer.requestLog.find(
      (r) => r.method === 'PUT' && r.path.includes('wf-123') && r.path.includes('webhook-output'),
    );
    expect(entry).toBeDefined();
    expect(entry!.body).toEqual({
      body: { result: 'ok' },
      status: 201,
      headers: { 'X-Request-Id': 'abc' },
    });
  });

  it('body-only call omits status and headers from PUT body', async () => {
    await sysDb.setWebhookOutput('wf-456', { result: 'plain' });

    const entry = mockServer.requestLog.find(
      (r) => r.method === 'PUT' && r.path.includes('wf-456') && r.path.includes('webhook-output'),
    );
    expect(entry).toBeDefined();
    expect(entry!.body).toEqual({ body: { result: 'plain' } });
  });
});
