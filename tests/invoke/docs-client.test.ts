/**
 * Task S1 (docs-access-w1, sdk#23) — `createDocsClient`: the run-scoped
 * `ctx.docs` client over `POST {apiUrl}/runs/{runId}/docs/{verb}`.
 *
 * Uses a real local HTTP server (house pattern — see database-client.test.ts)
 * that answers with the frozen contract's bodies, never a stubbed `fetch`.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
import type { AddressInfo } from 'node:net';
import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDocsClient } from '../../src/invoke/docs-client';
import type { DocsDoc } from '../../src/invoke/docs-client';
import type { DocsVar } from '../../src/invoke/types';
import { SolidActionsError, SolidActionsDocsError } from '../../src/error';

interface Seen {
  method: string;
  url: string;
  auth: string;
  session: string | undefined;
  body: unknown;
}

type Reply = { status: number; body: unknown; raw?: string };

/** Start a local HTTP server; every request is recorded in `seen`. */
async function startServer(respond: (seen: Seen) => Reply): Promise<{
  url: string;
  seen: Seen[];
  stop: () => Promise<void>;
}> {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers['authorization'] ?? '',
        session: req.headers['x-worker-session-id'] as string | undefined,
        body: text === '' ? undefined : JSON.parse(text),
      };
      seen.push(entry);
      const reply = respond(entry);
      res.statusCode = reply.status;
      res.setHeader('content-type', 'application/json');
      res.end(reply.raw ?? JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    seen,
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const RUN_ID = '00000000-0000-4000-8000-0000000000aa';
const API_KEY = '77:analytical-bearer-secret';
const DOC = {
  id: 5,
  title: 'a',
  folder_id: 2,
  type: null,
  properties: {},
  body: 'hi',
  revision: 9,
  updated_at: '2026-11-05T00:00:00Z',
  redacted_keys: [] as string[],
};

const FOLDER_VAR: DocsVar = { name: 'POSTS', path: 'Content/Posts', kind: 'folder', id: 12, level: 'edit' };
const FOLDER_VAR_NO_ID: DocsVar = { name: 'POSTS', path: 'Content/Posts', kind: 'folder', id: null, level: 'none' };

describe('createDocsClient: request shape per verb', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    server = await startServer(() => ({ status: 200, body: { doc: DOC } }));
  });
  afterEach(async () => {
    await server.stop();
  });

  const client = () => createDocsClient({ apiUrl: server.url, apiKey: API_KEY, runId: RUN_ID });
  const last = () => server.seen[server.seen.length - 1];

  it('read(path) POSTs {ref:{path}} to /runs/{runId}/docs/read with the Bearer key and returns the doc', async () => {
    const doc = await client().read('Content/Posts/a.md');

    expect(server.seen).toHaveLength(1);
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`/runs/${RUN_ID}/docs/read`);
    expect(last().auth).toBe(`Bearer ${API_KEY}`);
    expect(last().body).toEqual({ ref: { path: 'Content/Posts/a.md' } });
    expect(doc).toEqual(DOC);
  });

  it('read(id) sends {ref:{id}}', async () => {
    await client().read(12);

    expect(last().body).toEqual({ ref: { id: 12 } });
  });

  it('read(DocsVar of kind doc with an id) sends {ref:{id, kind:"doc"}}', async () => {
    await client().read({ name: 'NOTE', path: 'Notes/n.md', kind: 'doc', id: 31, level: 'view' });

    expect(last().body).toEqual({ ref: { id: 31, kind: 'doc' } });
  });

  it('read of an object with a path and no id at all (not even null) sends the path, never an empty ref', async () => {
    await client().read({ path: 'Content/a.md', kind: 'doc' } as unknown as DocsVar);

    expect(last().body).toEqual({ ref: { path: 'Content/a.md', kind: 'doc' } });
  });

  it('strips a trailing slash from apiUrl', async () => {
    await createDocsClient({ apiUrl: `${server.url}/`, apiKey: API_KEY, runId: RUN_ID }).read(1);

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/read`);
  });

  it('sends X-Worker-Session-ID when a worker session id is known, and omits it otherwise', async () => {
    await createDocsClient({ apiUrl: server.url, apiKey: API_KEY, runId: RUN_ID, workerSessionId: 'ws-1' }).read(1);
    await client().read(1);

    expect(server.seen[0].session).toBe('ws-1');
    expect(server.seen[1].session).toBeUndefined();
  });

  it('list(folder DocsVar with an id) sends {folder:{id, kind:"folder"}} plus the options', async () => {
    await client().list(FOLDER_VAR, { type: 'post', where: { status: 'draft' }, limit: 20, cursor: 'c1' });

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/list`);
    expect(last().body).toEqual({
      folder: { id: 12, kind: 'folder' },
      type: 'post',
      where: { status: 'draft' },
      limit: 20,
      cursor: 'c1',
    });
  });

  it('list(folder DocsVar whose id is null) falls back to the path, still with kind', async () => {
    await client().list(FOLDER_VAR_NO_ID);

    expect(last().body).toEqual({ folder: { path: 'Content/Posts', kind: 'folder' } });
  });

  it('search sends q, within, type, limit and cursor', async () => {
    await client().search('launch', { within: 'Content', type: 'post', limit: 5, cursor: 'c2' });

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/search`);
    expect(last().body).toEqual({
      q: 'launch',
      within: { path: 'Content' },
      type: 'post',
      limit: 5,
      cursor: 'c2',
    });
  });

  it('create sends the folder ref, title, body, properties and type', async () => {
    await client().create(FOLDER_VAR, { title: 'T', body: 'B', properties: { status: 'draft' }, type: 'post' });

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/create`);
    expect(last().body).toEqual({
      folder: { id: 12, kind: 'folder' },
      title: 'T',
      body: 'B',
      properties: { status: 'draft' },
      type: 'post',
    });
  });

  it('write sends the ref and the write fields including base_revision', async () => {
    await client().write('Content/a.md', { title: 'T2', body: 'B2', properties: { n: 1 }, baseRevision: 9 });

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/write`);
    expect(last().body).toEqual({
      ref: { path: 'Content/a.md' },
      title: 'T2',
      body: 'B2',
      properties: { n: 1 },
      base_revision: 9,
    });
  });

  it('append and prepend send the ref and text to their own routes', async () => {
    await client().append(5, 'tail');
    await client().prepend(5, 'head');

    expect(server.seen[0].url).toBe(`/runs/${RUN_ID}/docs/append`);
    expect(server.seen[0].body).toEqual({ ref: { id: 5 }, text: 'tail' });
    expect(server.seen[1].url).toBe(`/runs/${RUN_ID}/docs/prepend`);
    expect(server.seen[1].body).toEqual({ ref: { id: 5 }, text: 'head' });
  });

  it('updateProperties sends {ref, patch} to the camel-case verb route', async () => {
    await client().updateProperties(5, { status: 'live' });

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/updateProperties`);
    expect(last().body).toEqual({ ref: { id: 5 }, patch: { status: 'live' } });
  });

  it('setType sends {ref, type} and a null type clears it', async () => {
    await client().setType(5, 'post');
    await client().setType(5, null);

    expect(server.seen[0].url).toBe(`/runs/${RUN_ID}/docs/setType`);
    expect(server.seen[0].body).toEqual({ ref: { id: 5 }, type: 'post' });
    expect(server.seen[1].body).toEqual({ ref: { id: 5 }, type: null });
  });

  it('rename sends {ref, title}', async () => {
    await client().rename(5, 'New');

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/rename`);
    expect(last().body).toEqual({ ref: { id: 5 }, title: 'New' });
  });

  it('copy sends {ref, folder, title?}', async () => {
    await client().copy('Content/a.md', FOLDER_VAR, { title: 'Copy' });

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/copy`);
    expect(last().body).toEqual({
      ref: { path: 'Content/a.md' },
      folder: { id: 12, kind: 'folder' },
      title: 'Copy',
    });
  });

  it('createFolder sends {parent, name}', async () => {
    await client().createFolder(FOLDER_VAR, 'Drafts');

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/createFolder`);
    expect(last().body).toEqual({ parent: { id: 12, kind: 'folder' }, name: 'Drafts' });
  });

  it('restore sends {id, kind}', async () => {
    await client().restore(5, 'doc');

    expect(last().url).toBe(`/runs/${RUN_ID}/docs/restore`);
    expect(last().body).toEqual({ id: 5, kind: 'doc' });
  });

  it('trash(folder DocsVar) and move(folder DocsVar, dest) carry kind:"folder" so a doc with the same id is never touched', async () => {
    await client().trash(FOLDER_VAR);
    await client().move(FOLDER_VAR, 'Archive');

    expect(server.seen[0].url).toBe(`/runs/${RUN_ID}/docs/trash`);
    expect(server.seen[0].body).toEqual({ ref: { id: 12, kind: 'folder' } });
    expect(server.seen[1].url).toBe(`/runs/${RUN_ID}/docs/move`);
    expect(server.seen[1].body).toEqual({ ref: { id: 12, kind: 'folder' }, folder: { path: 'Archive' } });
  });

  it('trash(12) with no kind sends {id:12} only, and trash(12, {kind:"folder"}) sends the kind', async () => {
    await client().trash(12);
    await client().trash(12, { kind: 'folder' });

    expect(server.seen[0].body).toEqual({ ref: { id: 12 } });
    expect(server.seen[1].body).toEqual({ ref: { id: 12, kind: 'folder' } });
  });

  it('move(12, dest, {kind:"doc"}) sends the kind on the moved ref', async () => {
    await client().move(12, 'Archive', { kind: 'doc' });

    expect(last().body).toEqual({ ref: { id: 12, kind: 'doc' }, folder: { path: 'Archive' } });
  });
});

describe('createDocsClient: success unwrapping', () => {
  it('returns the folder for createFolder/move-of-folder, the docs page for list/search, and the flag for trash/restore', async () => {
    const replies: Record<string, unknown> = {
      list: { docs: [{ id: 1 }], next_cursor: 'n' },
      search: { docs: [], next_cursor: null },
      createFolder: { folder: { id: 3, name: 'Drafts', parent_id: 12 } },
      move: { folder: { id: 3, name: 'Drafts', parent_id: 13 } },
      trash: { trashed: true },
      restore: { restored: true },
    };
    const server = await startServer((s) => ({ status: 200, body: replies[s.url.split('/').pop() as string] }));
    const c = createDocsClient({ apiUrl: server.url, apiKey: API_KEY, runId: RUN_ID });
    try {
      expect(await c.list(FOLDER_VAR)).toEqual({ docs: [{ id: 1 }], next_cursor: 'n' });
      expect(await c.search('x')).toEqual({ docs: [], next_cursor: null });
      expect(await c.createFolder(FOLDER_VAR, 'Drafts')).toEqual({ id: 3, name: 'Drafts', parent_id: 12 });
      expect(await c.move(FOLDER_VAR, 'Other')).toEqual({ id: 3, name: 'Drafts', parent_id: 13 });
      expect(await c.trash(3)).toEqual({ trashed: true });
      expect(await c.restore(3, 'folder')).toEqual({ restored: true });
    } finally {
      await server.stop();
    }
  });
});

describe('createDocsClient: the doc shape', () => {
  it('a root doc keeps folder_id null and redacted_keys names the keys the app cannot see', async () => {
    const rootDoc = { ...DOC, folder_id: null, properties: { status: 'ok' }, redacted_keys: ['owner'] };
    const server = await startServer(() => ({ status: 200, body: { doc: rootDoc } }));
    const c = createDocsClient({ apiUrl: server.url, apiKey: API_KEY, runId: RUN_ID });
    try {
      const doc: DocsDoc = await c.read('Root.md');

      expect(doc.folder_id).toBeNull();
      expect(doc.redacted_keys).toEqual(['owner']);
    } finally {
      await server.stop();
    }
  });

  it('list and search rows carry redacted_keys too', async () => {
    const row = {
      id: 1,
      title: 'a',
      folder_id: null,
      type: null,
      properties: {},
      revision: 2,
      updated_at: 'x',
      redacted_keys: ['k'],
    };
    const server = await startServer(() => ({ status: 200, body: { docs: [row], next_cursor: null } }));
    const c = createDocsClient({ apiUrl: server.url, apiKey: API_KEY, runId: RUN_ID });
    try {
      const page = await c.list(FOLDER_VAR);

      expect(page.docs[0].redacted_keys).toEqual(['k']);
      expect(page.docs[0].folder_id).toBeNull();
    } finally {
      await server.stop();
    }
  });
});

describe('createDocsClient: errors', () => {
  const run = async (reply: Reply, call: (c: ReturnType<typeof createDocsClient>) => Promise<unknown>) => {
    const server = await startServer(() => reply);
    try {
      const c = createDocsClient({ apiUrl: server.url, apiKey: API_KEY, runId: RUN_ID });
      let error: unknown;
      try {
        await call(c);
      } catch (e) {
        error = e;
      }
      return { error, seen: server.seen };
    } finally {
      await server.stop();
    }
  };

  it('403 not_granted throws SolidActionsDocsError with code, status, path and message, and is a SolidActionsError', async () => {
    const { error, seen } = await run(
      { status: 403, body: { code: 'not_granted', message: 'No access to Content/Posts', path: 'Content/Posts' } },
      (c) => c.read('Content/Posts/a.md'),
    );

    expect(error).toBeInstanceOf(SolidActionsDocsError);
    expect(error).toBeInstanceOf(SolidActionsError);
    const e = error as SolidActionsDocsError;
    expect(e.code).toBe('not_granted');
    expect(e.status).toBe(403);
    expect(e.path).toBe('Content/Posts');
    expect(e.message).toBe('No access to Content/Posts');
    expect(seen).toHaveLength(1);
  });

  it('409 doc_stale keeps its code and is not retried', async () => {
    const { error, seen } = await run(
      { status: 409, body: { code: 'doc_stale', message: 'stale', current_revision: 12 } },
      (c) => c.write(5, { body: 'x', baseRevision: 3 }),
    );

    expect((error as SolidActionsDocsError).code).toBe('doc_stale');
    expect((error as SolidActionsDocsError).status).toBe(409);
    expect((error as SolidActionsDocsError).details).toEqual({ current_revision: 12 });
    expect(seen).toHaveLength(1);
  });

  it('429 rate_limited keeps its code and is not retried', async () => {
    const { error, seen } = await run(
      { status: 429, body: { code: 'rate_limited', message: 'slow down', retry_after_seconds: 7 } },
      (c) => c.read(1),
    );

    expect((error as SolidActionsDocsError).code).toBe('rate_limited');
    expect((error as SolidActionsDocsError).status).toBe(429);
    expect((error as SolidActionsDocsError).details).toEqual({ retry_after_seconds: 7 });
    expect(seen).toHaveLength(1);
  });

  it('422 invalid_request from the server for trash(12) with no kind surfaces as SolidActionsDocsError', async () => {
    const { error } = await run(
      { status: 422, body: { code: 'invalid_request', message: 'kind is required for an id', errors: {} } },
      (c) => c.trash(12),
    );

    expect((error as SolidActionsDocsError).code).toBe('invalid_request');
    expect((error as SolidActionsDocsError).status).toBe(422);
    expect((error as SolidActionsDocsError).details).toEqual({ errors: {} });
  });

  it('details holds only the fields beyond code, status, path and message, whatever else the server sent', async () => {
    const { error } = await run(
      {
        status: 422,
        body: {
          code: 'properties_invalid',
          message: 'bad',
          path: 'Content/a.md',
          errors: { status: ['must be one of: draft, live'] },
          current_revision: 4,
        },
      },
      (c) => c.updateProperties(5, { status: 'x' }),
    );

    const e = error as SolidActionsDocsError;
    expect(e.code).toBe('properties_invalid');
    expect(e.status).toBe(422);
    expect(e.path).toBe('Content/a.md');
    expect(e.message).toBe('bad');
    expect(e.details).toEqual({ errors: { status: ['must be one of: draft, live'] }, current_revision: 4 });
    expect(Object.keys(e.details ?? {})).not.toContain('code');
    expect(Object.keys(e.details ?? {})).not.toContain('message');
    expect(Object.keys(e.details ?? {})).not.toContain('path');
  });

  it('details is undefined when the body held nothing beyond the four named fields, or was not JSON', async () => {
    const plain = await run(
      { status: 403, body: { code: 'not_granted', message: 'No access', path: 'Content/Posts' } },
      (c) => c.read('Content/Posts/a.md'),
    );
    const html = await run({ status: 502, body: null, raw: '<html>Bad gateway</html>' }, (c) => c.read(1));

    expect(plain.error).toBeInstanceOf(SolidActionsDocsError);
    expect((plain.error as SolidActionsDocsError).details).toBeUndefined();
    expect(html.error).toBeInstanceOf(SolidActionsDocsError);
    expect((html.error as SolidActionsDocsError).details).toBeUndefined();
  });

  it('a 500 on create throws after exactly one request: a write is never resent', async () => {
    const { error, seen } = await run({ status: 500, body: { message: 'boom' } }, (c) =>
      c.create(FOLDER_VAR, { title: 'T' }),
    );

    expect(error).toBeInstanceOf(SolidActionsDocsError);
    expect(seen).toHaveLength(1);
  });

  it('a 500 on read also makes exactly one request: one rule for all verbs', async () => {
    const { error, seen } = await run({ status: 500, body: { message: 'boom' } }, (c) => c.read(1));

    expect(error).toBeInstanceOf(SolidActionsDocsError);
    expect(seen).toHaveLength(1);
  });

  it('a non-JSON error body becomes SolidActionsDocsError with code "unknown" and the real status', async () => {
    const { error } = await run({ status: 502, body: null, raw: '<html>Bad gateway</html>' }, (c) => c.read(1));

    expect(error).toBeInstanceOf(SolidActionsDocsError);
    expect((error as SolidActionsDocsError).code).toBe('unknown');
    expect((error as SolidActionsDocsError).status).toBe(502);
  });

  it('a JSON error body without a code becomes code "unknown"', async () => {
    const { error } = await run({ status: 500, body: { message: 'Server Error' } }, (c) => c.read(1));

    expect((error as SolidActionsDocsError).code).toBe('unknown');
    expect((error as SolidActionsDocsError).message).toBe('Server Error');
  });

  it('a transport failure (nothing listening) is not swallowed', async () => {
    const server = await startServer(() => ({ status: 200, body: {} }));
    const url = server.url;
    await server.stop();

    await expect(createDocsClient({ apiUrl: url, apiKey: API_KEY, runId: RUN_ID }).read(1)).rejects.toThrow();
  });

  it('logs nothing: the client source has no console, logger or telemetry reference, so a secret-looking body cannot reach a log', () => {
    const source = readFileSync(join(__dirname, '../../src/invoke/docs-client.ts'), 'utf8');

    expect(source).not.toMatch(/console\.|GlobalLogger|telemetry|logger/i);
  });
});
