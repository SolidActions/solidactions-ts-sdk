/**
 * Task 3.2 — Secrets snapshot-by-reference; `proxyToken` never persisted/logged.
 *
 * Task 3.1 lands a write-once ctx.vars snapshot on the durable run record. That
 * fix is correct for replay determinism, but on its own it leaks plaintext
 * secrets — a `ConnectionVar` carries `key` (the live connection key) and
 * `proxyToken` (a bearer for the run-shared proxy), both of which the runner
 * supplies fresh per dispatch. Naively serializing `ctx.vars` to JSON for the
 * snapshot writes those secrets straight into Postgres alongside the run row,
 * where they show up in any subsequent run-record read (admin UI, audit, logs)
 * for the life of the run.
 *
 * The fix: snapshot a `ConnectionVar` by REFERENCE (var name + the non-secret
 * `proxyUrl`), never by value. On every dispatch the runner re-injects the
 * live `ConnectionVar`; the snapshot-load path re-hydrates `key`/`proxyToken`
 * from the adapter-supplied live vars by name. The persisted snapshot, the
 * persisted step outputs, and the SDK logs must contain NEITHER `ctx.vars.X.key`
 * NOR `ctx.vars.X.proxyToken` for any secret-bearing connection var.
 *
 * What this test actually proves:
 *   - Define a workflow whose step legitimately consumes a `ConnectionVar`
 *     secret (it reads `ctx.vars.GCAL.key.length` — non-secret derivation that
 *     does NOT itself surface the secret bytes), then returns through one
 *     completed step.
 *   - Invoke with a known-secret `ConnectionVar`: key='live::gcal::SUPER|u',
 *     proxyToken='ptok-XYZ'.
 *   - Dump everything that the SDK durably persisted to the backend
 *     (mock store + every recorded request body) AND every line the SDK logged.
 *   - Assert NEITHER plaintext fragment appears anywhere.
 *
 * If any of: the vars-snapshot body, the step-output body, the run row, or any
 * log line contains 'live::gcal::SUPER|u' or 'ptok-XYZ' verbatim, the secret
 * leaked and this test fails.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
import { invoke } from '../../src/invoke/invoke';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { __clearRegistry } from '../../src/invoke/registry';
import { setUpSolidActionsTestServer, makeCtx, clearMockServerState } from '../helpers';
import { MockHttpServer } from '../../src/testing/mock_server';
import type { ConnectionVar } from '../../src/invoke/types';

const SECRET_KEY = 'live::gcal::SUPER|u';
const SECRET_PROXY_TOKEN = 'ptok-XYZ';

/**
 * Capture every console line the SDK emits during the test body, so we can
 * include them in the "did the secret leak?" sweep. The SDK's GlobalLogger
 * writes through console.{log,warn,error,info,debug} on the console transport;
 * we record those rather than installing a custom logger so we also catch any
 * bare console.* calls in the surrounding code path.
 */
function captureAllConsoleOutput(): { capturedLines: string[]; restore: () => void } {
  const captured: string[] = [];
  const methods = ['log', 'warn', 'error', 'info', 'debug'] as const;
  const originals: Record<string, (...args: unknown[]) => void> = {};
  for (const m of methods) {
    originals[m] = (console as unknown as Record<string, (...args: unknown[]) => void>)[m];
    (console as unknown as Record<string, (...args: unknown[]) => void>)[m] = (...args: unknown[]) => {
      const line = args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
      captured.push(line);
    };
  }
  return {
    capturedLines: captured,
    restore: () => {
      for (const m of methods) {
        (console as unknown as Record<string, (...args: unknown[]) => void>)[m] = originals[m];
      }
    },
  };
}

describe('Task 3.2 — secrets snapshot-by-reference; proxyToken never persisted/logged', () => {
  let srv: MockHttpServer;

  beforeAll(async () => {
    srv = await setUpSolidActionsTestServer();
  });

  beforeEach(() => {
    clearMockServerState();
    __clearRegistry();
  });

  it('plaintext ConnectionVar.key + proxyToken never appear in persisted state or logs', async () => {
    // ---- Workflow that consumes a secret connection var --------------------
    // The step records a NON-secret derivation (key.length) — proves the
    // workflow can use the secret at runtime without itself spilling the
    // bytes through the step output. The redaction layer must guarantee the
    // bytes never appear in the durable record EVEN THOUGH the workflow body
    // reads them.
    const wf = defineWorkflow<unknown, { keyLength: number; proxyUrlSeen: string }>({
      async run(ctx) {
        const gcal = ctx.vars.GCAL as ConnectionVar;
        return ctx.step(
          () => ({ keyLength: gcal.key.length, proxyUrlSeen: gcal.proxyUrl }),
          { name: 'use-gcal' },
        );
      },
    });

    // ---- Pre-seed the parent run row ---------------------------------------
    const RUN_ID = '00000000-0000-4000-8000-00000000beef';
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

    // ---- Capture console output (catches GlobalLogger console transport) ---
    const { capturedLines, restore } = captureAllConsoleOutput();

    try {
      const ctx = makeCtx<unknown>(srv, {
        input: {},
        vars: {
          GCAL: { key: SECRET_KEY, proxyUrl: 'http://proxy.internal', proxyToken: SECRET_PROXY_TOKEN },
        },
        run: {
          triggerId: 'test-trigger',
          runUuid: RUN_ID,
          runSecret: 'test-run-secret',
          workerSessionId: 'test-worker-session',
        },
      });

      const result = await invoke(wf, ctx);

      // Sanity: the workflow body could USE the secret at runtime — the
      // redaction is on the persistence boundary only.
      expect(result).toEqual({
        status: 'completed',
        output: { keyLength: SECRET_KEY.length, proxyUrlSeen: 'http://proxy.internal' },
      });
    } finally {
      restore();
    }

    // ---- The secret-leak sweep --------------------------------------------
    // Build a single string containing EVERYTHING the SDK could leak through:
    //   - the entire mock store (run rows, operations, messages, events,
    //     streams, eventDispatch)  ← persisted Postgres analogue
    //   - every recorded HTTP request body (the wire bytes the SDK sent)
    //   - every captured console line (the SDK's logs)
    // Stringify with JSON.stringify (NOT SolidActionsJSON) because we want the
    // raw bytes; the SuperJSON envelope cannot hide a secret from a raw byte
    // scan.
    const persistedStore = JSON.stringify({
      workflows: Array.from(srv.store.workflows.entries()),
      operations: Array.from(srv.store.operations.entries()),
      messages: srv.store.messages,
      events: Array.from(srv.store.events.entries()),
      streams: Array.from(srv.store.streams.entries()),
      eventDispatch: Array.from(srv.store.eventDispatch.entries()),
    });
    const requestLog = JSON.stringify(srv.requestLog);
    const logs = capturedLines.join('\n');
    const sweep = `${persistedStore}\n${requestLog}\n${logs}`;

    // The proof: neither secret fragment may appear anywhere in the sweep.
    expect(sweep).not.toContain(SECRET_KEY);
    expect(sweep).not.toContain(SECRET_PROXY_TOKEN);
  });
});
