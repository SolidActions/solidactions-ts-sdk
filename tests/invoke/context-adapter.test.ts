// jest globals — describe/it/expect are ambient; do NOT import from 'vitest'
import { oneShotContextAdapter } from '../../src/invoke/context-adapter';
import { SolidActionsJSON } from '../../src/serialization';

it('maps flat envVars (incl Pica connection) into typed ctx', async () => {
  const ctx = await oneShotContextAdapter({
    WORKFLOW_INPUT: '{"a":1}',
    SOLIDACTIONS_RUN_ID: 'ru',
    STEPS_TRIGGER_ID: '7',
    SOLIDACTIONS_API_KEY: '7:secret',
    SOLIDACTIONS_WORKER_SESSION_ID: 'ws',
    SOLIDACTIONS_API_URL: 'http://api',
    SOLIDACTIONS__APPID: 'app',
    SOLIDACTIONS__APPVERSION: 'v1',
    TENANT_ID: 't',
    MY_FLAG: 'on',
    GCAL: 'live::gcal::abc|u',
    SA_PROXY_URL: 'http://proxy',
    SA_PROXY_TOKEN: 'ptok',
  });
  expect(ctx.input).toEqual({ a: 1 });
  expect(ctx.run).toEqual({ runUuid: 'ru', triggerId: '7', runSecret: 'secret', workerSessionId: 'ws' });
  expect(ctx.vars.MY_FLAG).toBe('on');
  expect(ctx.vars.GCAL).toEqual({ key: 'live::gcal::abc|u', proxyUrl: 'http://proxy', proxyToken: 'ptok' });
  expect(ctx.mode).toBe('oneshot');
});

it('maps api and app fields correctly', async () => {
  const ctx = await oneShotContextAdapter({
    WORKFLOW_INPUT: '{"x":2}',
    SOLIDACTIONS_RUN_ID: 'run-123',
    STEPS_TRIGGER_ID: '42',
    SOLIDACTIONS_API_KEY: '42:mysecret',
    SOLIDACTIONS_WORKER_SESSION_ID: 'ws-abc',
    SOLIDACTIONS_API_URL: 'http://api',
    SOLIDACTIONS__APPID: 'app',
    SOLIDACTIONS__APPVERSION: 'v1',
    TENANT_ID: 't',
  });
  expect(ctx.api).toEqual({ url: 'http://api', key: '42:mysecret' });
  expect(ctx.app).toEqual({ appId: 'app', appVersion: 'v1', tenantId: 't' });
});

it('does not leak reserved keys into ctx.vars', async () => {
  const ctx = await oneShotContextAdapter({
    WORKFLOW_INPUT: '{"a":1}',
    SOLIDACTIONS_RUN_ID: 'ru',
    STEPS_TRIGGER_ID: '7',
    SOLIDACTIONS_API_KEY: '7:secret',
    SOLIDACTIONS_WORKER_SESSION_ID: 'ws',
    SOLIDACTIONS_API_URL: 'http://api',
    SOLIDACTIONS__APPID: 'app',
    SOLIDACTIONS__APPVERSION: 'v1',
    TENANT_ID: 't',
    MY_FLAG: 'on',
    GCAL: 'live::gcal::abc|u',
    SA_PROXY_URL: 'http://proxy',
    SA_PROXY_TOKEN: 'ptok',
  });
  const varKeys = Object.keys(ctx.vars);
  expect(varKeys.every((k) => !k.startsWith('SOLIDACTIONS_'))).toBe(true);
  expect(varKeys).not.toContain('WORKFLOW_INPUT');
  expect(varKeys).not.toContain('STEPS_TRIGGER_ID');
  expect(varKeys).not.toContain('TENANT_ID');
  expect(varKeys).not.toContain('SA_PROXY_URL');
  expect(varKeys).not.toContain('SA_PROXY_TOKEN');
});

it('throws a descriptive error on malformed WORKFLOW_INPUT', async () => {
  await expect(oneShotContextAdapter({ WORKFLOW_INPUT: '{bad json' })).rejects.toThrow(
    '[ContextAdapter] WORKFLOW_INPUT contains invalid JSON',
  );
});

// --- Regression: superjson-enveloped WORKFLOW_INPUT (child-workflow-dispatched runs) ---
// Child-dispatched runs deliver WORKFLOW_INPUT superjson-wrapped:
//   {"json":{...},"__solidactions_serializer":"superjson"}
// Raw JSON.parse used to return the envelope itself, so input.* came out null.
it('unwraps a superjson-enveloped WORKFLOW_INPUT (child-dispatched) to the real object', async () => {
  // This is exactly the shape the runner builds for child-workflow input
  // (verified against the live dev DB: run_triggers.trigger_input).
  const enveloped =
    '{"json":{"value":10,"parentId":"parent-001","operation":"double"},"__solidactions_serializer":"superjson"}';
  const ctx = await oneShotContextAdapter({ WORKFLOW_INPUT: enveloped });
  expect(ctx.input).toEqual({ value: 10, parentId: 'parent-001', operation: 'double' });
  // The defining symptom of the bug: input is NOT the raw envelope.
  expect(ctx.input).not.toHaveProperty('__solidactions_serializer');
  expect(ctx.input).not.toHaveProperty('json');
});

it('round-trips superjson-only types (Date, Map) through an enveloped WORKFLOW_INPUT', async () => {
  const original = {
    when: new Date('2026-01-02T03:04:05.000Z'),
    tags: new Map<string, number>([['a', 1]]),
    nested: { count: 42 },
  };
  // Build the envelope the same way the SDK serializes everywhere else.
  const enveloped = SolidActionsJSON.stringify(original);
  const ctx = await oneShotContextAdapter({ WORKFLOW_INPUT: enveloped });
  const input = ctx.input as typeof original;
  expect(input.when).toBeInstanceOf(Date);
  expect(input.when.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  expect(input.tags).toBeInstanceOf(Map);
  expect(input.tags.get('a')).toBe(1);
  expect(input.nested).toEqual({ count: 42 });
});

it('does NOT regress plain-JSON WORKFLOW_INPUT (webhook-style trigger input)', async () => {
  // Webhook triggers send plain, un-enveloped JSON — must pass through unchanged.
  const ctx = await oneShotContextAdapter({
    WORKFLOW_INPUT: '{"taskId":"e2e-001","taskData":"hello"}',
  });
  expect(ctx.input).toEqual({ taskId: 'e2e-001', taskData: 'hello' });
});

it('treats missing WORKFLOW_INPUT as an empty object', async () => {
  const ctx = await oneShotContextAdapter({ SOLIDACTIONS_RUN_ID: 'ru' });
  expect(ctx.input).toEqual({});
});

// --- WORKFLOW_INPUT_URL (large-payload fallback) ---

it('fetches WORKFLOW_INPUT_URL when WORKFLOW_INPUT is absent and parses with SolidActionsJSON (real local server, no mocks)', async () => {
  const payload = SolidActionsJSON.stringify({ big: 'value', n: 42 });
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(payload);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/input.json`;
  try {
    const ctx = await oneShotContextAdapter({ WORKFLOW_INPUT_URL: url });
    expect(ctx.input).toEqual({ big: 'value', n: 42 });
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

it('WORKFLOW_INPUT takes precedence over WORKFLOW_INPUT_URL when both are present (real local server, no mocks)', async () => {
  // Server would serve a different payload — WORKFLOW_INPUT must win.
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"from":"url"}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/input.json`;
  try {
    const ctx = await oneShotContextAdapter({
      WORKFLOW_INPUT: '{"from":"direct"}',
      WORKFLOW_INPUT_URL: url,
    });
    expect(ctx.input).toEqual({ from: 'direct' });
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

it('throws a descriptive error when WORKFLOW_INPUT_URL fetch returns a non-ok status (real local server, no mocks)', async () => {
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => {
    res.writeHead(404, 'Not Found');
    res.end('not found');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/missing.json`;
  try {
    await expect(oneShotContextAdapter({ WORKFLOW_INPUT_URL: url })).rejects.toThrow(
      '[ContextAdapter] WORKFLOW_INPUT_URL fetch failed',
    );
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
