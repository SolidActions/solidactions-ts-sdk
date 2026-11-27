/**
 * Step retries on the hosted (invoke) path (app#2961).
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
import { invoke } from '../../src/invoke/invoke';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { __clearRegistry } from '../../src/invoke/registry';
import { capRetryInterval, firstRetryInterval, nextRetryInterval } from '../../src/invoke/step-retry';
import { SolidActions } from '../../src';
import { SolidActionsMaxStepRetriesError } from '../../src/error';
import { StatusString } from '../../src/workflow';
import { setUpSolidActionsTestServer, makeCtx, clearMockServerState, Event } from '../helpers';
import { MockHttpServer } from '../../src/testing/mock_server';
import type { DurablePrimitives, InvokeCtx } from '../../src/invoke/types';

/** The run id `makeCtx` uses by default. */
const RUN_ID = '00000000-0000-4000-8000-000000000001';
const FAST = { retriesAllowed: true, intervalSeconds: 0.001 };

let srv: MockHttpServer;

beforeAll(async () => {
  srv = await setUpSolidActionsTestServer();
});

afterEach(() => {
  restoreConsole();
});

beforeEach(() => {
  ({ capturedLines: captured, restore: restoreConsole } = captureAllConsoleOutput());
  clearMockServerState();
  __clearRegistry();
  // The mock 404s recordOperation for an unknown run, so seed the run row.
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
    applicationID: 'test-app',
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

type Body = (ctx: InvokeCtx<unknown> & DurablePrimitives) => Promise<unknown>;

let workflowSeq = 0;
function run(body: Body, extra: Partial<InvokeCtx<unknown>> = {}) {
  const wf = defineWorkflow<unknown, unknown>({ name: `step-retry-${workflowSeq++}`, run: body });
  return invoke(wf, makeCtx<unknown>(srv, { input: {}, ...extra }));
}

const rows = () =>
  [...(srv.store.operations.get(RUN_ID) ?? [])].sort((a, b) => (a.functionId ?? 0) - (b.functionId ?? 0));

/** The console lines of the test, captured so retry warnings are asserted and do not flood CI output. */
let captured: string[] = [];
let restoreConsole: () => void = () => {};

function captureAllConsoleOutput(): { capturedLines: string[]; restore: () => void } {
  const lines: string[] = [];
  const methods = ['log', 'warn', 'error', 'info', 'debug'] as const;
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  const originals: Record<string, (...args: unknown[]) => void> = {};
  for (const m of methods) {
    originals[m] = target[m];
    target[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
  return {
    capturedLines: lines,
    restore: () => {
      for (const m of methods) target[m] = originals[m];
    },
  };
}

const retryLines = () => captured.filter((line) => line.includes('being automatically retried'));

const operationPosts = () =>
  srv.requestLog
    .filter((e) => e.method === 'POST' && e.path.endsWith('/operations'))
    .map((e) => e.body as Record<string, unknown>);

/** A step body that fails `failures` times, then returns 'done'. */
function flaky(failures: number) {
  const state = { calls: 0 };
  const fn = () => {
    state.calls++;
    if (state.calls <= failures) throw new Error(`boom ${state.calls}`);
    return Promise.resolve('done');
  };
  return { state, fn };
}

function failureOf(result: Awaited<ReturnType<typeof run>>): Error {
  if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  return result.error as Error;
}

describe('step retries on the hosted path', () => {
  it('succeeds on the third attempt and records one output row', async () => {
    const { state, fn } = flaky(2);
    const r = await run((c) => c.step(fn, { ...FAST, name: 'api' }));

    expect(r).toEqual({ status: 'completed', output: 'done' });
    expect(state.calls).toBe(3);
    expect(operationPosts()).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ functionId: 0, functionName: 'api', error: null });
  });

  it('throws SolidActionsMaxStepRetriesError after the last attempt and records one error row', async () => {
    const { state, fn } = flaky(99);
    const error = failureOf(await run((c) => c.step(fn, { ...FAST, maxAttempts: 3, name: 'api' })));

    expect(state.calls).toBe(3);
    expect(error).toBeInstanceOf(SolidActionsMaxStepRetriesError);
    expect((error as SolidActionsMaxStepRetriesError).errors.map((e) => e.message)).toEqual([
      'boom 1',
      'boom 2',
      'boom 3',
    ]);
    expect(operationPosts()).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].output).toBeNull();
    expect(rows()[0].error).toContain('exceeded its maximum of 3');
  });

  it.each([
    ['absent', undefined],
    ['false', { retriesAllowed: false, maxAttempts: 5 }],
  ])('runs once and throws the raw error when retriesAllowed is %s', async (_label, config) => {
    const { state, fn } = flaky(99);
    const error = failureOf(await run((c) => c.step(fn, config)));

    expect(state.calls).toBe(1);
    expect(error.message).toBe('boom 1');
    expect(rows()).toHaveLength(1);
  });

  it.each([
    [undefined, 3],
    [1, 1],
    [0, 0],
  ])('maxAttempts %s runs the step %s time(s)', async (maxAttempts, expected) => {
    const { state, fn } = flaky(99);
    const error = failureOf(await run((c) => c.step(fn, { ...FAST, maxAttempts })));

    expect(state.calls).toBe(expected);
    expect(error).toBeInstanceOf(SolidActionsMaxStepRetriesError);
  });

  it('SolidActions.runStep forwards the retry settings', async () => {
    const { state, fn } = flaky(2);
    const r = await run(() => SolidActions.runStep(fn, { ...FAST, name: 'api' }));

    expect(r).toEqual({ status: 'completed', output: 'done' });
    expect(state.calls).toBe(3);
    expect(rows()[0].functionName).toBe('api');
  });

  it('replays a recorded success without running the step', async () => {
    const { state, fn } = flaky(1);
    await run((c) => c.step(fn, FAST));
    const replay = await run((c) => c.step(fn, FAST));

    expect(replay).toEqual({ status: 'completed', output: 'done' });
    expect(state.calls).toBe(2);
    expect(operationPosts()).toHaveLength(1);
  });

  it('replays recorded exhausted retries without running the step', async () => {
    const { state, fn } = flaky(99);
    await run((c) => c.step(fn, { ...FAST, maxAttempts: 2 }));
    const error = failureOf(await run((c) => c.step(fn, { ...FAST, maxAttempts: 2 })));

    expect(state.calls).toBe(2);
    expect(error.message).toContain('exceeded its maximum of 2');
  });

  it('waits longer after each failure and not after the last one', async () => {
    const stamps: number[] = [];
    await run((c) =>
      c.step(
        () => {
          stamps.push(Date.now());
          throw new Error('boom');
        },
        { retriesAllowed: true, intervalSeconds: 0.05, backoffRate: 10, maxAttempts: 3 },
      ),
    );
    const done = Date.now();

    expect(stamps).toHaveLength(3);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(45);
    expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(450);
    // A third wait would be 5 seconds.
    expect(done - stamps[2]).toBeLessThan(2500);
  });

  it('defaults to 1 second doubling and caps every wait at one hour', () => {
    expect(firstRetryInterval({})).toBe(1);
    expect(firstRetryInterval({ intervalSeconds: 7200 })).toBe(3600);
    expect(nextRetryInterval(1, {})).toBe(2);
    expect(nextRetryInterval(2000, {})).toBe(3600);
    expect(nextRetryInterval(2, { backoffRate: 3 })).toBe(6);
    expect(capRetryInterval(3601)).toBe(3600);
  });

  it('ends the run cancelled when it is cancelled between attempts, and records nothing', async () => {
    let calls = 0;
    const r = await run((c) =>
      c.step(() => {
        calls++;
        srv.store.workflows.get(RUN_ID)!.status = StatusString.CANCELLED;
        throw new Error('boom');
      }, FAST),
    );

    expect(r).toEqual({ status: 'cancelled' });
    expect(calls).toBe(1);
    expect(operationPosts()).toHaveLength(0);
  });

  it('caps the first wait of a huge interval and says so once', async () => {
    const { state, fn } = flaky(99);
    const started = Date.now();
    await run((c) => c.step(fn, { retriesAllowed: true, intervalSeconds: 7200, maxAttempts: 1 }));

    expect(state.calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(captured.filter((line) => line.includes('capped to 3600 seconds'))).toHaveLength(1);
  });

  it('does not count a cancellation raised inside an attempt', async () => {
    const child = defineWorkflow<unknown, string>({ name: 'cancel-child', run: () => Promise.resolve('x') });
    let calls = 0;
    const r = await run(async () => {
      const start = SolidActions.startWorkflow(child) as unknown as (
        input: unknown,
      ) => Promise<{ getResult: () => Promise<string> }>;
      const handle = await start({});
      return SolidActions.runStep(async () => {
        calls++;
        srv.store.workflows.get(RUN_ID)!.status = StatusString.CANCELLED;
        return await handle.getResult();
      }, FAST);
    });

    expect(r).toEqual({ status: 'cancelled' });
    expect(calls).toBe(1);
    expect(retryLines()).toHaveLength(0);
    // Ids 0 and 1 belong to the child start and its result; the step is id 2.
    expect(operationPosts().some((body) => body.functionID === 2)).toBe(false);
  });

  it('suspends without counting or recording when the step waits on a child result', async () => {
    const child = defineWorkflow<unknown, string>({ name: 'step-retry-child', run: () => Promise.resolve('x') });
    let calls = 0;
    const r = await run(async () => {
      const start = SolidActions.startWorkflow(child) as unknown as (
        input: unknown,
      ) => Promise<{ getResult: () => Promise<string> }>;
      const handle = await start({});
      return SolidActions.runStep(async () => {
        calls++;
        return await handle.getResult();
      }, FAST);
    });

    expect(r).toEqual({ status: 'suspended', reason: 'child' });
    expect(calls).toBe(1);
    // Ids 0 and 1 belong to the child start and its result; the step is id 2.
    expect(rows().map((o) => o.functionId)).not.toContain(2);
  });

  it('does not run the step again, or record an error, when recording the result fails', async () => {
    let calls = 0;
    const r = await run((c) =>
      c.step(() => {
        calls++;
        srv.store.operations.delete(RUN_ID);
        return 'done';
      }, FAST),
    );

    expect(r.status).toBe('failed');
    expect(calls).toBe(1);
    expect(operationPosts().length).toBeGreaterThan(0);
    expect(operationPosts().every((body) => body.error === undefined)).toBe(true);
  });

  it('treats nested step, now, randomUUID and sleep as plain calls: one id per retried step', async () => {
    let outer = 0;
    let nested = 0;
    const r = await run(async (c) => {
      await c.step(async () => {
        outer++;
        await SolidActions.runStep(
          () => {
            nested++;
            return Promise.resolve(1);
          },
          { ...FAST, maxAttempts: 5 },
        );
        await c.step(() => 2);
        await SolidActions.now();
        await SolidActions.randomUUID();
        await SolidActions.sleep(5);
        await c.sleep(5);
        if (outer === 1) throw new Error('boom');
        return 'done';
      }, FAST);
      return c.step(() => 'after');
    });

    expect(r).toEqual({ status: 'completed', output: 'after' });
    expect(outer).toBe(2);
    expect(nested).toBe(2);
    expect(rows().map((o) => o.functionId)).toEqual([0, 1]);
    expect(srv.lastSleepSchedule()).toBeUndefined();
  });

  it('does not retry a failing nested step on its own', async () => {
    let nested = 0;
    await run((c) =>
      c.step(
        () =>
          c.step(
            () => {
              nested++;
              throw new Error('inner');
            },
            { ...FAST, maxAttempts: 5 },
          ),
        { ...FAST, maxAttempts: 2 },
      ),
    );

    expect(nested).toBe(2);
    expect(rows()).toHaveLength(1);
  });

  type Ctx = InvokeCtx<unknown> & DurablePrimitives;
  type Child = ReturnType<typeof defineWorkflow<unknown, string>>;
  const refused: Array<[string, (c: Ctx, child: Child) => Promise<unknown>]> = [
    ['ctx.send', (c) => c.send('topic', 1)],
    ['ctx.recv', (c) => c.recv('topic')],
    ['SolidActions.send', () => SolidActions.send(RUN_ID, 1, 'topic')],
    ['SolidActions.recv', () => SolidActions.recv('topic')],
    ['SolidActions.setEvent', () => SolidActions.setEvent('key', 1)],
    [
      'SolidActions.startWorkflow',
      (_c, child) => (SolidActions.startWorkflow(child) as unknown as (input: unknown) => Promise<unknown>)({}),
    ],
  ];

  it.each(refused)('refuses %s inside a retried step without using an id', async (operation, call) => {
    const child = defineWorkflow<unknown, string>({ name: 'refused-child', run: () => Promise.resolve('x') });
    let calls = 0;
    let message = '';
    const r = await run(async (c) => {
      try {
        await c.step(
          async () => {
            calls++;
            await call(c, child);
          },
          { ...FAST, maxAttempts: 2 },
        );
      } catch (error) {
        message = (error as Error).message;
      }
      return c.step(() => 'after');
    });

    expect(r).toEqual({ status: 'completed', output: 'after' });
    expect(calls).toBe(2);
    expect(message).toContain(`Invalid call to \`${operation}\`: not allowed inside a step`);
    expect(rows().map((o) => o.functionId)).toEqual([0, 1]);
    expect(srv.requestLog.filter((e) => /\/(messages|events|wait)(\/|$)/.test(e.path))).toHaveLength(0);
    expect(srv.store.workflows.size).toBe(1);
  });

  it('leaves calls inside a step without retries as before: they use their own id', async () => {
    const r = await run(async (c) => {
      await c.step(async () => {
        await c.send('topic', 1);
        return 'ok';
      });
      return c.step(() => 'after');
    });

    expect(r).toEqual({ status: 'completed', output: 'after' });
    const afterRow = rows().find((o) => o.functionId === 2);
    expect(afterRow).toBeDefined();
  });

  it('keeps ids stable across concurrent retried steps, and does not mark sibling calls', async () => {
    const a = flaky(2);
    const b = flaky(0);
    const attemptStarted = new Event();
    const sendSettled = new Event();
    let attemptOpen = false;
    let attemptOpenAtSend = false;
    // The first attempt of `a` stays open until the sibling send has settled.
    const heldOpen = async () => {
      attemptOpen = true;
      attemptStarted.set();
      await sendSettled.wait();
      attemptOpen = false;
      return a.fn();
    };
    const r = await run(async (c) => {
      const results = await Promise.all([
        c.step(heldOpen, { retriesAllowed: true, intervalSeconds: 0.02, name: 'a' }),
        c.step(b.fn, { ...FAST, name: 'b' }),
        // Sent from the body, outside any step, while an attempt of a retried step is running.
        attemptStarted
          .wait()
          .then(() => {
            attemptOpenAtSend = attemptOpen;
            return c.send('topic', 1);
          })
          .finally(() => sendSettled.set())
          .then(() => 'sent'),
      ]);
      return results;
    });

    expect(attemptOpenAtSend).toBe(true);
    expect(r).toEqual({ status: 'completed', output: ['done', 'done', 'sent'] });
    expect(rows().find((o) => o.functionName === 'a')?.functionId).toBe(0);
    expect(rows().find((o) => o.functionName === 'b')?.functionId).toBe(1);
  });

  it('retries a thrown non-Error value', async () => {
    let calls = 0;
    const error = failureOf(
      await run((c) =>
        c.step(
          () => {
            calls++;
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject('plain string failure');
          },
          { ...FAST, maxAttempts: 2 },
        ),
      ),
    );

    expect(calls).toBe(2);
    expect(error.message).toContain('plain string failure');
  });

  it('logs one warning per failed attempt with secrets scrubbed from logs and rows', async () => {
    const SECRET = 'live::retry::SECRET';
    await run(
      (c) =>
        c.step(
          () => {
            throw new Error(`request failed with ${SECRET}`);
          },
          { ...FAST, maxAttempts: 2 },
        ),
      { vars: { API: { key: SECRET, proxyUrl: 'http://proxy.internal', proxyToken: 'ptok-retry' } } },
    );

    const lines = retryLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Attempt 1 of 2');
    expect(lines[1]).toContain('Attempt 2 of 2');
    expect(captured.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(rows())).not.toContain(SECRET);
  });
});
