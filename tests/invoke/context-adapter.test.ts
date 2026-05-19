// jest globals — describe/it/expect are ambient; do NOT import from 'vitest'
import { oneShotContextAdapter } from '../../src/invoke/context-adapter';
import { SolidActionsJSON } from '../../src/serialization';

it('maps flat envVars (incl Pica connection) into typed ctx', () => {
  const ctx = oneShotContextAdapter({
    WORKFLOW_INPUT: '{"a":1}', SOLIDACTIONS_RUN_ID: 'ru', STEPS_TRIGGER_ID: '7',
    SOLIDACTIONS_API_KEY: '7:secret', SOLIDACTIONS_WORKER_SESSION_ID: 'ws',
    SOLIDACTIONS_API_URL: 'http://api', SOLIDACTIONS__APPID: 'app', SOLIDACTIONS__APPVERSION: 'v1', TENANT_ID: 't',
    MY_FLAG: 'on', GCAL: 'live::gcal::abc|u', SA_PROXY_URL: 'http://proxy', SA_PROXY_TOKEN: 'ptok',
  });
  expect(ctx.input).toEqual({ a: 1 });
  expect(ctx.run).toEqual({ runUuid: 'ru', triggerId: '7', runSecret: 'secret', workerSessionId: 'ws' });
  expect(ctx.vars.MY_FLAG).toBe('on');
  expect(ctx.vars.GCAL).toEqual({ key: 'live::gcal::abc|u', proxyUrl: 'http://proxy', proxyToken: 'ptok' });
  expect(ctx.mode).toBe('oneshot');
});

it('maps api and app fields correctly', () => {
  const ctx = oneShotContextAdapter({
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

it('does not leak reserved keys into ctx.vars', () => {
  const ctx = oneShotContextAdapter({
    WORKFLOW_INPUT: '{"a":1}', SOLIDACTIONS_RUN_ID: 'ru', STEPS_TRIGGER_ID: '7',
    SOLIDACTIONS_API_KEY: '7:secret', SOLIDACTIONS_WORKER_SESSION_ID: 'ws',
    SOLIDACTIONS_API_URL: 'http://api', SOLIDACTIONS__APPID: 'app', SOLIDACTIONS__APPVERSION: 'v1', TENANT_ID: 't',
    MY_FLAG: 'on', GCAL: 'live::gcal::abc|u', SA_PROXY_URL: 'http://proxy', SA_PROXY_TOKEN: 'ptok',
  });
  const varKeys = Object.keys(ctx.vars);
  expect(varKeys.every(k => !k.startsWith('SOLIDACTIONS_'))).toBe(true);
  expect(varKeys).not.toContain('WORKFLOW_INPUT');
  expect(varKeys).not.toContain('STEPS_TRIGGER_ID');
  expect(varKeys).not.toContain('TENANT_ID');
  expect(varKeys).not.toContain('SA_PROXY_URL');
  expect(varKeys).not.toContain('SA_PROXY_TOKEN');
});

it('throws a descriptive error on malformed WORKFLOW_INPUT', () => {
  expect(() => oneShotContextAdapter({ WORKFLOW_INPUT: '{bad json' }))
    .toThrow('[ContextAdapter] WORKFLOW_INPUT contains invalid JSON');
});

// --- Regression: superjson-enveloped WORKFLOW_INPUT (child-workflow-dispatched runs) ---
// Child-dispatched runs deliver WORKFLOW_INPUT superjson-wrapped:
//   {"json":{...},"__solidactions_serializer":"superjson"}
// Raw JSON.parse used to return the envelope itself, so input.* came out null.
it('unwraps a superjson-enveloped WORKFLOW_INPUT (child-dispatched) to the real object', () => {
  // This is exactly the shape the runner builds for child-workflow input
  // (verified against the live dev DB: run_triggers.trigger_input).
  const enveloped = '{"json":{"value":10,"parentId":"parent-001","operation":"double"},"__solidactions_serializer":"superjson"}';
  const ctx = oneShotContextAdapter({ WORKFLOW_INPUT: enveloped });
  expect(ctx.input).toEqual({ value: 10, parentId: 'parent-001', operation: 'double' });
  // The defining symptom of the bug: input is NOT the raw envelope.
  expect(ctx.input).not.toHaveProperty('__solidactions_serializer');
  expect(ctx.input).not.toHaveProperty('json');
});

it('round-trips superjson-only types (Date, Map) through an enveloped WORKFLOW_INPUT', () => {
  const original = {
    when: new Date('2026-01-02T03:04:05.000Z'),
    tags: new Map<string, number>([['a', 1]]),
    nested: { count: 42 },
  };
  // Build the envelope the same way the SDK serializes everywhere else.
  const enveloped = SolidActionsJSON.stringify(original);
  const ctx = oneShotContextAdapter({ WORKFLOW_INPUT: enveloped });
  const input = ctx.input as typeof original;
  expect(input.when).toBeInstanceOf(Date);
  expect(input.when.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  expect(input.tags).toBeInstanceOf(Map);
  expect(input.tags.get('a')).toBe(1);
  expect(input.nested).toEqual({ count: 42 });
});

it('does NOT regress plain-JSON WORKFLOW_INPUT (webhook-style trigger input)', () => {
  // Webhook triggers send plain, un-enveloped JSON — must pass through unchanged.
  const ctx = oneShotContextAdapter({
    WORKFLOW_INPUT: '{"taskId":"e2e-001","taskData":"hello"}',
  });
  expect(ctx.input).toEqual({ taskId: 'e2e-001', taskData: 'hello' });
});

it('treats missing WORKFLOW_INPUT as an empty object', () => {
  const ctx = oneShotContextAdapter({ SOLIDACTIONS_RUN_ID: 'ru' });
  expect(ctx.input).toEqual({});
});
