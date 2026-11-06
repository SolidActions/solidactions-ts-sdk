/**
 * Task S1 (docs-access-w1, sdk#23) — `DocsVar` classification from the
 * `SOLIDACTIONS__DOC_KEYS` manifest, the reserved `SA_VIEWER_*` keys, and
 * `ctx.docs` on a real `invoke`.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 * No mocks/spies/stubs/fakes per project testing rules.
 */
import { oneShotContextAdapter, residentContextAdapter } from '../../src/invoke/context-adapter';
import { invoke } from '../../src/invoke/invoke';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { __clearRegistry } from '../../src/invoke/registry';
import { setUpSolidActionsTestServer, makeCtx, clearMockServerState } from '../helpers';
import { MockHttpServer } from '../../src/testing/mock_server';
import { SolidActionsDocsError } from '../../src/error';
import { parseDeclarations } from '../../src/invoke/declarations';
import {
  isDocsVar,
  redactVarsForSnapshot,
  rehydrateVarsFromSnapshot,
  collectSecretStrings,
} from '../../src/invoke/secret-redaction';
import type { ConnectionVar, DatabaseVar, DocsVar } from '../../src/invoke/types';

const POSTS_JSON = JSON.stringify({ path: 'Content/Posts', kind: 'folder', id: 12, level: 'edit' });

describe('context-adapter: SOLIDACTIONS__DOC_KEYS manifest classification', () => {
  it('a key listed in SOLIDACTIONS__DOC_KEYS parses its JSON into a DocsVar with its name', async () => {
    const ctx = await oneShotContextAdapter({
      SOLIDACTIONS__DOC_KEYS: 'POSTS',
      POSTS: POSTS_JSON,
      SOLIDACTIONS_RUN_ID: 'ru',
    });

    expect(ctx.vars.POSTS).toEqual({ name: 'POSTS', path: 'Content/Posts', kind: 'folder', id: 12, level: 'edit' });
  });

  it('the resident adapter classifies the same way', async () => {
    const ctx = await residentContextAdapter({
      triggerId: 1,
      runSecret: 's',
      envVars: { SOLIDACTIONS__DOC_KEYS: 'POSTS', POSTS: POSTS_JSON, SOLIDACTIONS_RUN_ID: 'ru' },
    });

    expect(ctx.vars.POSTS).toEqual({ name: 'POSTS', path: 'Content/Posts', kind: 'folder', id: 12, level: 'edit' });
  });

  it('a level-none doc var carries id null and a doc kind', async () => {
    const ctx = await oneShotContextAdapter({
      SOLIDACTIONS__DOC_KEYS: 'NOTE',
      NOTE: JSON.stringify({ path: 'Notes/n.md', kind: 'doc', id: null, level: 'none' }),
      SOLIDACTIONS_RUN_ID: 'ru',
    });

    expect(ctx.vars.NOTE).toEqual({ name: 'NOTE', path: 'Notes/n.md', kind: 'doc', id: null, level: 'none' });
  });

  it('a malformed value for a listed key stays the raw string, as parseDatabaseVar does', async () => {
    const ctx = await oneShotContextAdapter({
      SOLIDACTIONS__DOC_KEYS: 'BAD,WRONGSHAPE,BADLEVEL',
      BAD: '{not json',
      WRONGSHAPE: JSON.stringify({ path: 'x' }),
      BADLEVEL: JSON.stringify({ path: 'x', kind: 'folder', id: 1, level: 'manage' }),
      SOLIDACTIONS_RUN_ID: 'ru',
    });

    expect(ctx.vars.BAD).toBe('{not json');
    expect(ctx.vars.WRONGSHAPE).toBe(JSON.stringify({ path: 'x' }));
    expect(ctx.vars.BADLEVEL).toBe(JSON.stringify({ path: 'x', kind: 'folder', id: 1, level: 'manage' }));
  });

  it('a JSON value NOT listed in the manifest stays a plain string', async () => {
    const ctx = await oneShotContextAdapter({ OTHER: POSTS_JSON, SOLIDACTIONS_RUN_ID: 'ru' });

    expect(ctx.vars.OTHER).toBe(POSTS_JSON);
  });

  it('SOLIDACTIONS__DOC_KEYS itself never lands in ctx.vars', async () => {
    const ctx = await oneShotContextAdapter({
      SOLIDACTIONS__DOC_KEYS: 'POSTS',
      POSTS: POSTS_JSON,
      SOLIDACTIONS_RUN_ID: 'ru',
    });

    expect(Object.keys(ctx.vars)).not.toContain('SOLIDACTIONS__DOC_KEYS');
  });
});

describe('context-adapter: SA_VIEWER_* are reserved', () => {
  it('SA_VIEWER_ID, SA_VIEWER_TYPE and SA_VIEWER_NAME never appear in ctx.vars, with or without a var manifest', async () => {
    const viewer = { SA_VIEWER_ID: '7', SA_VIEWER_TYPE: 'user', SA_VIEWER_NAME: 'Ada', MY_FLAG: 'on' };
    const noManifest = await oneShotContextAdapter({ ...viewer, SOLIDACTIONS_RUN_ID: 'ru' });
    const manifest = await oneShotContextAdapter({
      ...viewer,
      SOLIDACTIONS__VAR_KEYS: 'MY_FLAG,SA_VIEWER_ID,SA_VIEWER_TYPE,SA_VIEWER_NAME',
      SOLIDACTIONS_RUN_ID: 'ru',
    });

    expect(Object.keys(noManifest.vars)).toEqual(['MY_FLAG']);
    expect(Object.keys(manifest.vars)).toEqual(['MY_FLAG']);
  });
});

const POSTS_VAR: DocsVar = { name: 'POSTS', path: 'Content/Posts', kind: 'folder', id: 12, level: 'edit' };

/** Registers the run row a real dispatch has already created, so `invoke` takes its normal vars-snapshot path. */
function seedRun(
  srv: MockHttpServer,
  runUuid: string,
): { triggerId: string; runUuid: string; runSecret: string; workerSessionId: string } {
  srv.store.workflows.set(runUuid, {
    workflowUUID: runUuid,
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
  srv.store.operations.set(runUuid, []);
  return { triggerId: 'test-trigger', runUuid, runSecret: 'test-run-secret', workerSessionId: 'test-worker-session' };
}

describe('invoke: ctx.docs', () => {
  let srv: MockHttpServer;

  beforeAll(async () => {
    srv = await setUpSolidActionsTestServer();
  });
  beforeEach(() => {
    clearMockServerState();
    __clearRegistry();
  });

  it('ctx.docs is present beside step, sleep, recv and send', async () => {
    const wf = defineWorkflow({
      run(ctx) {
        const verbs = ['read', 'list', 'search', 'create', 'write', 'append', 'prepend', 'updateProperties', 'setType'];
        const more = ['rename', 'move', 'copy', 'trash', 'restore', 'createFolder'];
        return Promise.resolve({
          primitives: [ctx.step, ctx.sleep, ctx.recv, ctx.send].every((f) => typeof f === 'function'),
          docs: [...verbs, ...more].every(
            (v) => typeof (ctx.docs as unknown as Record<string, unknown>)[v] === 'function',
          ),
        });
      },
    });

    const run = seedRun(srv, '00000000-0000-4000-8000-00000000d0c1');

    const r = await invoke(wf, makeCtx(srv, { input: {}, run }));

    expect(r).toEqual({ status: 'completed', output: { primitives: true, docs: true } });
  });

  it('ctx.docs calls the run-scoped docs route under ctx.api.url with the run uuid and the api key', async () => {
    const wf = defineWorkflow({
      async run(ctx) {
        try {
          await ctx.docs.read('Content/a.md');
          return 'no-error';
        } catch (e) {
          return e instanceof SolidActionsDocsError ? 'docs-error' : 'other-error';
        }
      },
    });
    const run = seedRun(srv, '00000000-0000-4000-8000-00000000d0c2');
    const before = srv.requestLog.length;

    const r = await invoke(wf, makeCtx(srv, { input: {}, run }));

    const docsCalls = srv.requestLog.slice(before).filter((q) => q.path.includes('/docs/'));
    expect(r).toEqual({ status: 'completed', output: 'docs-error' });
    expect(docsCalls.map((q) => ({ method: q.method, path: q.path, body: q.body }))).toEqual([
      {
        method: 'POST',
        path: '/runs/00000000-0000-4000-8000-00000000d0c2/docs/read',
        body: { ref: { path: 'Content/a.md' } },
      },
    ]);
    expect(docsCalls[0].headers['authorization']).toBe('Bearer test-api-key');
  });
});

describe('secret-redaction: a DocsVar holds no secret and survives the snapshot', () => {
  it('isDocsVar accepts a DocsVar and rejects a string, a ConnectionVar, a DatabaseVar and a bad level or kind', () => {
    const connection: ConnectionVar = { key: 'k', proxyUrl: 'http://p', proxyToken: 't' };
    const database: DatabaseVar = { name: 'DB', url: 'libsql://x', token: 'tok', readOnly: false };

    expect(isDocsVar(POSTS_VAR)).toBe(true);
    expect(isDocsVar({ ...POSTS_VAR, id: null, level: 'none' })).toBe(true);
    expect(isDocsVar('POSTS')).toBe(false);
    expect(isDocsVar(null)).toBe(false);
    expect(isDocsVar(connection)).toBe(false);
    expect(isDocsVar(database)).toBe(false);
    expect(isDocsVar({ ...POSTS_VAR, level: 'manage' })).toBe(false);
    expect(isDocsVar({ ...POSTS_VAR, kind: 'file' })).toBe(false);
    expect(isDocsVar({ ...POSTS_VAR, id: '12' })).toBe(false);
  });

  it('redactVarsForSnapshot passes a DocsVar through unchanged and still redacts a ConnectionVar beside it', () => {
    const connection: ConnectionVar = { key: 'live-key', proxyUrl: 'http://p', proxyToken: 'live-token' };

    const out = redactVarsForSnapshot({ POSTS: POSTS_VAR, GCAL: connection, FLAG: 'on' });

    expect(out['POSTS']).toEqual(POSTS_VAR);
    expect(out['FLAG']).toBe('on');
    expect(JSON.stringify(out)).not.toContain('live-key');
    expect(JSON.stringify(out)).not.toContain('live-token');
  });

  it('a DocsVar adds nothing to the secret set that scrubs persisted output', () => {
    expect(collectSecretStrings({ POSTS: POSTS_VAR })).toEqual([]);
  });

  it('rehydrateVarsFromSnapshot returns a DocsVar from a JSON-round-tripped snapshot, not "[object Object]"', () => {
    const persisted = JSON.parse(JSON.stringify(redactVarsForSnapshot({ POSTS: POSTS_VAR }))) as Record<
      string,
      unknown
    >;

    const out = rehydrateVarsFromSnapshot(persisted, {});

    expect(out['POSTS']).toEqual(POSTS_VAR);
    expect(typeof out['POSTS']).toBe('object');
  });

  it('a malformed docs-shaped snapshot entry still falls to the unknown-shape string, as before', () => {
    const out = rehydrateVarsFromSnapshot({ BAD: { ...POSTS_VAR, level: 'manage' } }, {});

    expect(out['BAD']).toBe('[object Object]');
  });
});

describe('invoke: a DocsVar survives suspend and replay', () => {
  let srv: MockHttpServer;

  beforeAll(async () => {
    srv = await setUpSolidActionsTestServer();
  });
  beforeEach(() => {
    clearMockServerState();
    __clearRegistry();
  });

  it('after a sleep, the second dispatch sees ctx.vars.POSTS as the same DocsVar the first dispatch saw', async () => {
    const wf = defineWorkflow<unknown, unknown>({
      async run(ctx) {
        const before = ctx.vars['POSTS'];
        await ctx.step(() => 'recorded', { name: 's1' });
        await ctx.sleep(1000);
        return { before, after: ctx.vars['POSTS'] };
      },
    });
    const RUN_ID = '00000000-0000-4000-8000-00000000d0c5';
    const run = seedRun(srv, RUN_ID);
    const first = await invoke(wf, makeCtx<unknown>(srv, { input: {}, vars: { POSTS: POSTS_VAR }, run }));
    srv.store.operations.get(RUN_ID)!.push({
      workflowUUID: RUN_ID,
      functionId: 1,
      functionName: 'SolidActions.sleep',
      output: JSON.stringify({ wakeupTime: Date.now() - 1 }),
      error: null,
    });
    const replay = await invoke(wf, makeCtx<unknown>(srv, { input: {}, vars: { POSTS: POSTS_VAR }, run }));

    expect(first).toEqual({ status: 'suspended', reason: 'sleep' });
    expect(replay).toEqual({ status: 'completed', output: { before: POSTS_VAR, after: POSTS_VAR } });
  });
});

describe('declarations: docs is a real kind beside oauth and database', () => {
  it('parses { docs: "..." } into declarations.docs and keeps the other kinds apart', () => {
    const decls = parseDeclarations(`
env:
  - PLAIN_VAR
  - GCAL:
      oauth: "Google Calendar"
  - MYDB:
      database: "Main"
  - POSTS:
      docs: "Content/Posts"
  - NOTE:
      docs: "Notes/n.md"
`);

    expect(decls.vars).toEqual(['PLAIN_VAR']);
    expect(decls.connections).toEqual(['GCAL']);
    expect(decls.databases).toEqual(['MYDB']);
    expect(decls.docs).toEqual(['POSTS', 'NOTE']);
  });

  it('yaml without env, or without any docs entry, parses docs as an empty list', () => {
    expect(parseDeclarations('name: x').docs).toEqual([]);
    expect(parseDeclarations('env:\n  - A\n').docs).toEqual([]);
    expect(parseDeclarations('').docs).toEqual([]);
  });

  it('a docs entry with a non-string value is a plain var, not a docs mapping', () => {
    const decls = parseDeclarations(`
env:
  - ODD:
      docs: 5
`);

    expect(decls.docs).toEqual([]);
    expect(decls.vars).toEqual(['ODD']);
  });
});
