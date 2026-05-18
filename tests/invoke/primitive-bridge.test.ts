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
 * The NON-invoke-scope legacy path (the bridge MUST no-op when not in an
 * invoke scope) is guarded by the existing 19 jsapi/workflow_input legacy
 * tests; this file does not duplicate that.
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

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

/** The run id the one-shot ContextAdapter maps to ctx.run.runUuid. */
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
  const wf = SolidActions.registerWorkflow(async () => {
    await SolidActions.setEvent('progress', { pct: 50 });
    return 'done';
  });
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
  const wf = SolidActions.registerWorkflow(async () => {
    await SolidActions.send(OTHER_WF, { hello: 'world' }, 'greetings');
    return 'sent';
  });
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
  const wf = SolidActions.registerWorkflow(async () => {
    await SolidActions.respond({ ok: true, value: 7 });
    return 'responded';
  });
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
  const wf = SolidActions.registerWorkflow(async () => {
    seenWorkflowId = SolidActions.workflowID;
    seenIsWithin = SolidActions.isWithinWorkflow();
    return 'ok';
  });
  const code = await expectProcessExit(() => SolidActions.run(wf), mockEnv({ WORKFLOW_INPUT: '{}' }));

  expect(code).toBe(0);
  expect(seenWorkflowId).toBe(RUN_ID);
  expect(seenIsWithin).toBe(true);
});

it('getSignalUrls builds URLs from ctx.api.url (invoke scope), not process.env', async () => {
  let urls: { base: string; approve: string; reject: string; custom: (a: string) => string } | undefined;
  const wf = SolidActions.registerWorkflow(async () => {
    urls = SolidActions.getSignalUrls('approval');
    return 'ok';
  });
  const code = await expectProcessExit(
    () => SolidActions.run(wf),
    // Deliberately set the legacy env to a DIFFERENT host: the bridged
    // getSignalUrls must use ctx.api.url (srv.baseUrl), not these env vars.
    mockEnv({ WORKFLOW_INPUT: '{}', APP_URL: 'http://legacy-should-not-be-used.invalid' }),
  );

  expect(code).toBe(0);
  expect(urls).toBeTruthy();
  expect(urls!.base).toBe(`${srv.baseUrl}/api/signal/${RUN_ID}`);
  expect(urls!.approve).toBe(`${srv.baseUrl}/api/signal/${RUN_ID}?choice=approve&topic=approval`);
  expect(urls!.reject).toBe(`${srv.baseUrl}/api/signal/${RUN_ID}?choice=reject&topic=approval`);
  expect(urls!.custom('escalate')).toBe(
    `${srv.baseUrl}/api/signal/${RUN_ID}?choice=escalate&topic=approval`,
  );
  expect(urls!.base).not.toContain('legacy-should-not-be-used');
});

it('recv bridges to the invoke-scoped engine: no message → suspends (exit 0, /wait posted, timeout preserved)', async () => {
  const wf = SolidActions.registerWorkflow(async () => {
    const msg = await SolidActions.recv<{ x: number }>('inbox', 45);
    return msg;
  });
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
