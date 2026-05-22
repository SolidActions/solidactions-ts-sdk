// jest globals — describe/it/expect are ambient; do NOT import from 'vitest'
import { residentContextAdapter } from '../../src/invoke/context-adapter';
import { SolidActionsJSON } from '../../src/serialization';

/** The dispatched /run body shape (POC resident.mjs / spec dispatch contract). */
function body(envVars: Record<string, string>) {
  return {
    triggerId: '7',
    runSecret: 'secret',
    workerSessionId: 'ws-1',
    envVars: {
      SOLIDACTIONS_API_URL: 'http://api.internal/api/internal',
      SOLIDACTIONS_API_KEY: '7:secret',
      SOLIDACTIONS__APPID: 'app',
      SOLIDACTIONS__APPVERSION: 'v1',
      TENANT_ID: 't',
      ...envVars,
    },
  };
}

it('maps body → typed ctx with mode "resident"; identity comes from the body, not process.env', async () => {
  const ctx = await residentContextAdapter(body({ WORKFLOW_INPUT: '{"a":1}' }));
  expect(ctx.mode).toBe('resident');
  expect(ctx.input).toEqual({ a: 1 });
  expect(ctx.run).toEqual({ runUuid: '', triggerId: '7', runSecret: 'secret', workerSessionId: 'ws-1' });
  expect(ctx.api).toEqual({ url: 'http://api.internal/api/internal', key: '7:secret' });
  expect(ctx.app).toEqual({ appId: 'app', appVersion: 'v1', tenantId: 't' });
});

it('takes runUuid + workerSessionId from envVars when present (SOLIDACTIONS_RUN_ID / SOLIDACTIONS_WORKER_SESSION_ID)', async () => {
  const ctx = await residentContextAdapter(
    body({ WORKFLOW_INPUT: '{}', SOLIDACTIONS_RUN_ID: 'run-xyz', SOLIDACTIONS_WORKER_SESSION_ID: 'ws-env' }),
  );
  expect(ctx.run.runUuid).toBe('run-xyz');
  expect(ctx.run.workerSessionId).toBe('ws-env');
});

it('parses WORKFLOW_INPUT with SolidActionsJSON.parse (unwraps a superjson envelope)', async () => {
  const enveloped = SolidActionsJSON.stringify({ when: new Date('2026-01-02T03:04:05.000Z') });
  const ctx = await residentContextAdapter(body({ WORKFLOW_INPUT: enveloped }));
  const input = ctx.input as { when: Date };
  expect(input.when).toBeInstanceOf(Date);
  expect(input.when.toISOString()).toBe('2026-01-02T03:04:05.000Z');
});

it('fetches WORKFLOW_INPUT_URL when WORKFLOW_INPUT is absent (large-payload fallback) and parses with SolidActionsJSON', async () => {
  const payload = SolidActionsJSON.stringify({ big: 'value', n: 42 });
  // Real local HTTP server — no fetch mocking.
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(payload);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/input.json`;
  try {
    const ctx = await residentContextAdapter(body({ WORKFLOW_INPUT_URL: url }));
    expect(ctx.input).toEqual({ big: 'value', n: 42 });
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

it('throws a descriptive error on malformed WORKFLOW_INPUT', async () => {
  await expect(residentContextAdapter(body({ WORKFLOW_INPUT: '{bad json' }))).rejects.toThrow(
    '[ResidentContextAdapter] WORKFLOW_INPUT contains invalid JSON',
  );
});

it('does not leak reserved keys into ctx.vars but keeps scalar vars', async () => {
  const ctx = await residentContextAdapter(body({ WORKFLOW_INPUT: '{}', MY_FLAG: 'on' }));
  expect(ctx.vars.MY_FLAG).toBe('on');
  expect(Object.keys(ctx.vars).every((k) => !k.startsWith('SOLIDACTIONS_'))).toBe(true);
  expect(Object.keys(ctx.vars)).not.toContain('TENANT_ID');
  expect(Object.keys(ctx.vars)).not.toContain('WORKFLOW_INPUT_URL');
});

// --- Authorization header for WORKFLOW_INPUT_URL (the bug — resident path) ---

it('sends Authorization: Bearer <SOLIDACTIONS_API_KEY> when fetching WORKFLOW_INPUT_URL on the resident path (real local auth-gated server, no mocks)', async () => {
  const expectedApiKey = '7:secret'; // same as body() default fixture
  const payload = JSON.stringify({ resident: true });
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const authHeader = req.headers['authorization'] ?? '';
    if (authHeader !== `Bearer ${expectedApiKey}`) {
      res.writeHead(401, 'Unauthorized');
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(payload);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/workflow-input`;
  try {
    // SOLIDACTIONS_API_KEY is set in the body() fixture's envVars.
    const ctx = await residentContextAdapter(body({ WORKFLOW_INPUT_URL: url }));
    expect(ctx.input).toEqual({ resident: true });
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
