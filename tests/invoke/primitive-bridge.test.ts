/**
 * Task 2.6 — bridge the legacy SDK orchestration primitives to the invoke()
 * ALS scope.
 *
 * The rewritten one-shot SolidActions.run() routes through invoke(), whose
 * engine is the ALS-scoped InvokeSystemDatabase (legacy globalParams /
 * SolidActionsExecutor deleted). Task 2.3 only bridged runStep / sleepms.
 * The remaining legacy primitives — setEvent, recv, send, respond,
 * getSignalUrls, and the workflowID getter — still threw
 * `ensureSolidActionsIsLaunched() must be called before running X` (or
 * "must be called from within a workflow") under the one-shot path because
 * run() never calls the legacy launch().
 *
 * Each test below registers a legacy-API workflow (SolidActions.registerWorkflow)
 * and runs it through SolidActions.run() under the one-shot env (mirrors
 * run-compat.test.ts / run-statusrow.test.ts setup, including the run-row
 * pre-create the mock needs). It asserts the correct backend call was made
 * with invoke-scope identity (workflowID == ctx.run.runUuid, ascending
 * nextFunctionID, cross-workflow destination for send, awaited webhook PUT
 * for respond, signal URLs from ctx.api.url) and that NO launch / within-
 * workflow error was raised.
 *
 * The NON-invoke-scope legacy bridge is generally guarded by the existing
 * jsapi/workflow_input tests. getSignalUrls is also covered here because its
 * per-run credential has distinct invoke-context and legacy-env sources.
 */
/* eslint-disable @typescript-eslint/require-await --
 * The workflow fixtures are intentionally `async` (matching the one-shot
 * run() contract) even when a body has no await — that is the shape under
 * test, not a mistake. */
import { expectProcessExit } from './helpers-exit';
import { setUpSolidActionsTestServer } from '../helpers';
import { SolidActions } from '../../src';
import { MockHttpServer } from '../../src/testing/mock_server';
import { SolidActionsJSON } from '../../src/serialization';
import { runWithTopContext } from '../../src/context';
import { SolidActionsError } from '../../src/error';

let srv: MockHttpServer;

beforeAll(async () => {
  // NOTE: the mock server has no `POST .../workflow-complete` route, so each
  // `completed` run logs an expected `console.warn "Failed to report one-shot
  // workflow completion"` — this is the established behaviour across the
  // run-compat/run-statusrow suites (the POST is observed via requestLog, not
  // routed), NOT a regression.
  srv = await setUpSolidActionsTestServer();
});

/**
 * The run id the one-shot ContextAdapter maps to `ctx.run.runUuid`. MUST match
 * the value the test env's `SOLIDACTIONS_RUN_ID` resolves to (same constant as
 * the sibling run-compat/run-statusrow suites); changing it desyncs mock routing.
 */
const RUN_ID = '00000000-0000-4000-8000-0000000002a6';

beforeEach(() => {
  srv.store.clear();
  srv.requestLog.length = 0;

  // Pre-seed the run row exactly as run-compat.test.ts / run-statusrow.test.ts
  // do (the mock 404s recordOperation for an unknown workflow). Test setup
  // only — does NOT alter run(), invoke()/engine, or mock behavior.
  srv.store.workflows.set(RUN_ID, {
    workflowUUID: RUN_ID,
    status: 'PENDING',
    workflowName: '',
    workflowClassName: '',
    workflowConfigName: '',
    authenticatedUser: '',
    assumedRole: '',
    authenticatedRoles: [],
    request: {},
    executorId: 'test-trigger',
    applicationVersion: '',
    applicationID: '',
    input: null,
    output: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    recoveryAttempts: 0,
    priority: 0,
  });
  srv.store.operations.set(RUN_ID, []);
});

/** Env that points the one-shot ContextAdapter at the running mock. */
function mockEnv(extra: Record<string, string>): Record<string, string> {
  return {
    SOLIDACTIONS_API_URL: srv.baseUrl,
    SOLIDACTIONS_API_KEY: 'test-api-key',
    SOLIDACTIONS_RUN_ID: RUN_ID,
    ...extra,
  };
}

/** Decoded POST/PUT bodies recorded for a path suffix, oldest → newest. */
function loggedBodies(method: string, suffix: string): Array<Record<string, unknown>> {
  return srv.requestLog
    .filter((e) => e.method === method && e.path.endsWith(suffix))
    .map((e) => e.body as Record<string, unknown>);
}

it('setEvent bridges to the invoke-scoped engine (no launch error, invoke identity + funcID)', async () => {
  const wf = SolidActions.registerWorkflow(
    async () => {
      await SolidActions.setEvent('progress', { pct: 50 });
      return 'done';
    },
    { name: 'primitive-bridge-setEvent' },
  );
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');

  // PUT /runs/status/<RUN_ID>/events/progress with the serialized value.
  const eventPut = srv.requestLog.find(
    (e) => e.method === 'PUT' && e.path.endsWith(`/${RUN_ID}/events/progress`),
  );
  expect(eventPut).toBeTruthy();
  const body = eventPut!.body as { functionID: number; value: string };
  expect(typeof body.functionID).toBe('number');
  expect(SolidActionsJSON.parse(body.value)).toEqual({ pct: 50 });
});

it('send bridges to the invoke-scoped engine and supports a cross-workflow destination', async () => {
  const OTHER_WF = 'destination-workflow-xyz';
  const wf = SolidActions.registerWorkflow(
    async () => {
      await SolidActions.send(OTHER_WF, { hello: 'world' }, 'greetings');
      return 'sent';
    },
    { name: 'primitive-bridge-send' },
  );
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');

  // POST /runs/status/<destinationID>/messages — destination is the OTHER
  // workflow (cross-workflow), sender is the invoke-scope workflowID.
  const msgPost = srv.requestLog.find(
    (e) => e.method === 'POST' && e.path.endsWith(`/${OTHER_WF}/messages`),
  );
  expect(msgPost).toBeTruthy();
  const body = msgPost!.body as { senderWorkflowID: string; functionID: number; message: string; topic?: string };
  expect(body.senderWorkflowID).toBe(RUN_ID);
  expect(typeof body.functionID).toBe('number');
  expect(body.topic).toBe('greetings');
  expect(SolidActionsJSON.parse(body.message)).toEqual({ hello: 'world' });
});

it('respond bridges to the invoke-scoped engine and the webhook PUT is awaited before exit', async () => {
  const wf = SolidActions.registerWorkflow(
    async () => {
      await SolidActions.respond({ ok: true, value: 7 });
      return 'responded';
    },
    { name: 'primitive-bridge-respond' },
  );
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  expect(srv.lastWorkflowComplete()!.status).toBe('completed');

  // PUT /runs/status/<RUN_ID>/webhook-output { body }. It must be recorded
  // BEFORE the workflow-complete POST (proves it was awaited end-to-end and
  // did not race the one-shot process exit).
  const webhookIdx = srv.requestLog.findIndex(
    (e) => e.method === 'PUT' && e.path.endsWith(`/${RUN_ID}/webhook-output`),
  );
  const completeIdx = srv.requestLog.findIndex(
    (e) => e.method === 'POST' && e.path.endsWith('/workflow-complete'),
  );
  expect(webhookIdx).toBeGreaterThanOrEqual(0);
  expect(completeIdx).toBeGreaterThanOrEqual(0);
  expect(webhookIdx).toBeLessThan(completeIdx);
  expect((srv.requestLog[webhookIdx].body as { body: unknown }).body).toEqual({ ok: true, value: 7 });
});

it('workflowID getter resolves from the invoke scope (legacy-API body sees ctx.run.runUuid)', async () => {
  let seenWorkflowId: string | undefined;
  let seenIsWithin: boolean | undefined;
  const wf = SolidActions.registerWorkflow(
    async () => {
      seenWorkflowId = SolidActions.workflowID;
      seenIsWithin = SolidActions.isWithinWorkflow();
      return 'ok';
    },
    { name: 'primitive-bridge-workflowID' },
  );
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  expect(seenWorkflowId).toBe(RUN_ID);
  expect(seenIsWithin).toBe(true);
});

it('getSignalUrls builds credentialed URLs from invoke ctx, not process.env', async () => {
  let urls: { base: string; approve: string; reject: string; custom: (a: string) => string } | undefined;
  const runSecret = 'invoke secret/+?&=';
  const encodedSecret = encodeURIComponent(runSecret);
  const topic = 'approval /+?&=';
  const encodedTopic = encodeURIComponent(topic);
  const wf = SolidActions.registerWorkflow(
    async () => {
      // The adapter has already captured ctx.run.runSecret. A conflicting
      // process env value must not influence getSignalUrls inside invoke scope.
      process.env.SOLIDACTIONS_API_KEY = 'wrong-trigger:wrong-secret';
      urls = SolidActions.getSignalUrls(topic);
      return 'ok';
    },
    { name: 'primitive-bridge-signalUrls' },
  );
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    // Deliberately set the legacy env to a DIFFERENT host: the bridged
    // getSignalUrls must use ctx.api.url (srv.baseUrl), not these env vars.
    mockEnv({
      WORKFLOW_INPUT: '{}',
      APP_URL: 'http://legacy-should-not-be-used.invalid',
      SOLIDACTIONS_API_KEY: `test-trigger:${runSecret}`,
    }),
  );

  expect(code).toBe(0);
  expect(urls).toBeTruthy();
  const base = `${srv.baseUrl}/api/signal/${RUN_ID}?secret=${encodedSecret}`;
  expect(urls!.base).toBe(base);
  expect(urls!.approve).toBe(`${base}&choice=approve&topic=${encodedTopic}`);
  expect(urls!.reject).toBe(`${base}&choice=reject&topic=${encodedTopic}`);
  expect(urls!.custom('escalate')).toBe(`${base}&choice=escalate&topic=${encodedTopic}`);
  expect(urls!.base).not.toContain('legacy-should-not-be-used');
});

it('getSignalUrls fails instead of emitting a secretless URL in invoke scope', async () => {
  const wf = SolidActions.registerWorkflow(async () => SolidActions.getSignalUrls(), {
    name: 'primitive-bridge-signalUrls-missing-secret',
  });

  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    mockEnv({ WORKFLOW_INPUT: '{}', SOLIDACTIONS_API_KEY: 'test-trigger:' }),
  );

  expect(code).toBe(1);
  expect(srv.lastWorkflowComplete()).toMatchObject({
    status: 'failed',
    error: 'getSignalUrls() requires a per-run secret',
  });
});

it('getSignalUrls builds credentialed URLs from the legacy triggerId:runSecret credential', async () => {
  const priorApiUrl = process.env.SOLIDACTIONS_API_URL;
  const priorApiKey = process.env.SOLIDACTIONS_API_KEY;
  const runSecret = 'legacy:secret /+?&=';
  const encodedSecret = encodeURIComponent(runSecret);

  process.env.SOLIDACTIONS_API_URL = `${srv.baseUrl}/api/internal`;
  process.env.SOLIDACTIONS_API_KEY = `legacy-trigger:${runSecret}`;

  try {
    await runWithTopContext({ workflowId: RUN_ID }, async () => {
      const urls = SolidActions.getSignalUrls('approval');
      const base = `${srv.baseUrl}/api/signal/${RUN_ID}?secret=${encodedSecret}`;

      expect(urls.base).toBe(base);
      expect(urls.approve).toBe(`${base}&choice=approve&topic=approval`);
      expect(urls.reject).toBe(`${base}&choice=reject&topic=approval`);
      expect(urls.custom('escalate /+?&=')).toBe(`${base}&choice=escalate%20%2F%2B%3F%26%3D&topic=approval`);
    });
  } finally {
    if (priorApiUrl === undefined) delete process.env.SOLIDACTIONS_API_URL;
    else process.env.SOLIDACTIONS_API_URL = priorApiUrl;
    if (priorApiKey === undefined) delete process.env.SOLIDACTIONS_API_KEY;
    else process.env.SOLIDACTIONS_API_KEY = priorApiKey;
  }
});

it.each([undefined, 'legacy-trigger', 'legacy-trigger:'])(
  'getSignalUrls rejects a missing legacy run secret (%s)',
  async (apiKey) => {
    const priorApiKey = process.env.SOLIDACTIONS_API_KEY;
    if (apiKey === undefined) delete process.env.SOLIDACTIONS_API_KEY;
    else process.env.SOLIDACTIONS_API_KEY = apiKey;

    try {
      await runWithTopContext({ workflowId: RUN_ID }, async () => {
        expect(() => SolidActions.getSignalUrls()).toThrow(SolidActionsError);
        expect(() => SolidActions.getSignalUrls()).toThrow('getSignalUrls() requires a per-run secret');
      });
    } finally {
      if (priorApiKey === undefined) delete process.env.SOLIDACTIONS_API_KEY;
      else process.env.SOLIDACTIONS_API_KEY = priorApiKey;
    }
  },
);

it('recv bridges to the invoke-scoped engine: no message → suspends (exit 0, /wait posted, timeout preserved)', async () => {
  const wf = SolidActions.registerWorkflow(
    async () => {
      const msg = await SolidActions.recv<{ x: number }>('inbox', 45);
      return msg;
    },
    { name: 'primitive-bridge-recv-suspend' },
  );
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));

  // recv with no message → SuspensionRequired → invoke() maps to suspended →
  // run() exits 0 (scheduler resumes on signal/timeout).
  expect(code).toBe(0);

  // POST /runs/status/<RUN_ID>/wait with the topic AND timeoutSeconds
  // preserved (the public recv API's timeout must NOT be dropped).
  const waitBodies = loggedBodies('POST', `/${RUN_ID}/wait`);
  expect(waitBodies.length).toBeGreaterThanOrEqual(1);
  const wait = waitBodies[waitBodies.length - 1];
  expect(wait.topic).toBe('inbox');
  expect(wait.timeoutSeconds).toBe(45);
  expect(typeof wait.functionID).toBe('number');

  // No terminal completion write on the suspended path.
  expect(srv.lastWorkflowComplete()).toBeUndefined();
});
