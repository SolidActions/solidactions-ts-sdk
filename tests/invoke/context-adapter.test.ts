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

// --- SOLIDACTIONS__VAR_KEYS manifest: allowlist + single-source-of-truth scrub ---
// RuntimeEnvBuilder emits SOLIDACTIONS__VAR_KEYS = the tenant-declared var keys.
// When present it is authoritative: ctx.vars is built from EXACTLY those keys
// (so container base env like PATH never pollutes ctx.vars), and those keys are
// deleted from the transport (process.env) so ctx.vars is the single source.

it('with a manifest present, builds ctx.vars from ONLY the listed keys (container base env like PATH is ignored)', async () => {
  const ctx = await oneShotContextAdapter({
    SOLIDACTIONS__VAR_KEYS: 'MY_FLAG,GCAL',
    MY_FLAG: 'on',
    GCAL: 'live::gcal::abc|u',
    SA_PROXY_URL: 'http://proxy',
    SA_PROXY_TOKEN: 'ptok',
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/root',
    NODE_VERSION: '22.0.0',
    SOLIDACTIONS_RUN_ID: 'ru',
  });
  expect(Object.keys(ctx.vars).sort()).toEqual(['GCAL', 'MY_FLAG']);
  expect(ctx.vars.MY_FLAG).toBe('on');
  expect(ctx.vars.GCAL).toEqual({ key: 'live::gcal::abc|u', proxyUrl: 'http://proxy', proxyToken: 'ptok' });
});

it('with a manifest present, deletes the listed var keys from the transport but keeps reserved + base env', async () => {
  const env: Record<string, string> = {
    SOLIDACTIONS__VAR_KEYS: 'MY_FLAG,GCAL',
    MY_FLAG: 'on',
    GCAL: 'live::gcal::abc|u',
    SA_PROXY_URL: 'http://proxy',
    SA_PROXY_TOKEN: 'ptok',
    PATH: '/usr/bin',
    SOLIDACTIONS_RUN_ID: 'ru',
    SOLIDACTIONS_API_KEY: '7:secret',
  };
  await oneShotContextAdapter(env);
  // Tenant vars are scrubbed → ctx.vars is the only way to read them.
  expect(env.MY_FLAG).toBeUndefined();
  expect(env.GCAL).toBeUndefined();
  // Reserved framework keys stay — the SDK's own internals still read them from process.env.
  expect(env.SOLIDACTIONS_RUN_ID).toBe('ru');
  expect(env.SOLIDACTIONS_API_KEY).toBe('7:secret');
  expect(env.SA_PROXY_URL).toBe('http://proxy');
  // Container base env is never touched.
  expect(env.PATH).toBe('/usr/bin');
});

it('with an empty manifest, produces no vars and scrubs nothing', async () => {
  const env: Record<string, string> = { SOLIDACTIONS__VAR_KEYS: '', MY_FLAG: 'on', PATH: '/usr/bin' };
  const ctx = await oneShotContextAdapter(env);
  expect(Object.keys(ctx.vars)).toEqual([]);
  // MY_FLAG is not in the (authoritative) manifest, so it is not a tenant var and is not deleted.
  expect(env.MY_FLAG).toBe('on');
});

it('WITHOUT a manifest (legacy/local), falls back to scanning non-reserved keys and does NOT scrub the transport', async () => {
  const env: Record<string, string> = {
    MY_FLAG: 'on',
    GCAL: 'live::gcal::abc|u',
    SA_PROXY_URL: 'http://proxy',
    SA_PROXY_TOKEN: 'ptok',
    SOLIDACTIONS_RUN_ID: 'ru',
  };
  const ctx = await oneShotContextAdapter(env);
  expect(ctx.vars.MY_FLAG).toBe('on');
  expect(ctx.vars.GCAL).toEqual({ key: 'live::gcal::abc|u', proxyUrl: 'http://proxy', proxyToken: 'ptok' });
  // No authoritative key list → unsafe to delete, so the transport is left intact.
  expect(env.MY_FLAG).toBe('on');
  expect(env.GCAL).toBe('live::gcal::abc|u');
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

it('throws a descriptive error when WORKFLOW_INPUT_URL returns 200 with a non-JSON body (real local server, no mocks)', async () => {
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end('this is not json at all');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/input.json`;
  try {
    await expect(oneShotContextAdapter({ WORKFLOW_INPUT_URL: url })).rejects.toThrow(
      '[ContextAdapter] WORKFLOW_INPUT_URL contains invalid JSON',
    );
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// --- Authorization header for WORKFLOW_INPUT_URL (the bug) ---
// The endpoint requires Bearer auth (triggerId:runSecret = SOLIDACTIONS_API_KEY).
// Without the header the server returns 401, which used to throw and abort the run.

it('sends Authorization: Bearer <SOLIDACTIONS_API_KEY> when fetching WORKFLOW_INPUT_URL (real local auth-gated server, no mocks)', async () => {
  const expectedApiKey = '42:supersecret';
  const payload = JSON.stringify({ answer: 42 });
  const http = await import('node:http');
  // Real server that enforces Bearer auth — returns 401 without the correct header.
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
    // With the correct api key: succeeds and parses the payload.
    const ctx = await oneShotContextAdapter({
      WORKFLOW_INPUT_URL: url,
      SOLIDACTIONS_API_KEY: expectedApiKey,
    });
    expect(ctx.input).toEqual({ answer: 42 });
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

it('throws a descriptive error when WORKFLOW_INPUT_URL fetch returns 401 because no api key is available (real local auth-gated server, no mocks)', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const authHeader = req.headers['authorization'] ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      res.writeHead(401, 'Unauthorized');
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/workflow-input`;
  try {
    // Without SOLIDACTIONS_API_KEY the adapter must still attempt the fetch
    // (with an empty/no Bearer) and throw the 401 error descriptively.
    await expect(oneShotContextAdapter({ WORKFLOW_INPUT_URL: url })).rejects.toThrow(
      '[ContextAdapter] WORKFLOW_INPUT_URL fetch failed',
    );
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
