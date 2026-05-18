// jest globals — describe/it/expect are ambient; do NOT import from 'vitest'
import { oneShotContextAdapter } from '../../src/invoke/context-adapter';

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
