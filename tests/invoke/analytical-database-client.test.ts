import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  AnalyticalIngestError,
  createAnalyticalDatabaseClient,
  createDatabaseClient,
  type AnalyticalDatabaseBinding,
  type DatabaseVar,
} from '../../src';
import { runInScope } from '../../src/invoke/runtime-scope';

const DATABASE = '123e4567-e89b-12d3-a456-426614174000';
const execFileAsync = promisify(execFile);

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function jsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected JSON object');
  return parsed as Record<string, unknown>;
}

function field(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== 'string') throw new Error(`expected string field ${key}`);
  return found;
}

function ackReply(batchId: string, overrides: Record<string, unknown> = {}) {
  return {
    batch_id: batchId,
    state: 'acked',
    rows: 0,
    durable: true,
    live_bytes: 0,
    acked_at: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const srv = createServer(handler);
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const address = srv.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return { srv, url: `http://127.0.0.1:${address.port}` };
}

function env(url: string) {
  process.env.SOLIDACTIONS_API_URL = `${url}/api/internal/`;
  process.env.SOLIDACTIONS_API_KEY = 'run:key';
}

afterEach(() => {
  delete process.env.SOLIDACTIONS_API_URL;
  delete process.env.SOLIDACTIONS_API_KEY;
});

describe('analytical database client', () => {
  it('is exported from the package root with symmetric cross-kind teaching guards', () => {
    expect(createAnalyticalDatabaseClient).toBeDefined();
    expect(() => createAnalyticalDatabaseClient({ name: 'x', url: 'libsql://x', token: 't', readOnly: false })).toThrow(
      /createDatabaseClient/,
    );
    expect(() => createDatabaseClient(DATABASE)).toThrow(/createAnalyticalDatabaseClient/);
  });

  it('accepts generated database unions at both factories without casts', () => {
    const compileOnly = (binding: DatabaseVar | AnalyticalDatabaseBinding) => [
      createDatabaseClient(binding),
      createAnalyticalDatabaseClient(binding),
    ];
    expect(typeof compileOnly).toBe('function');
  });

  it('prefers a complete runtime transport, never mixes it with env, and falls back only outside scope', async () => {
    const authorizations: Array<string | undefined> = [];
    const { srv, url } = await server(async (req, res) => {
      authorizations.push(req.headers.authorization);
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(ackReply(field(sent, 'batch_id'))));
    });
    env(url);
    const runtimeParams = {
      workflowID: 'w',
      executorID: 'e',
      appId: 'a',
      appVersion: '1',
      apiUrl: `${url}/runtime`,
      apiKey: 'scope:key',
      runSecret: 'secret',
      functionIDCounter: 0,
    };
    try {
      await runInScope({ executor: undefined as never, runtimeParams }, () =>
        createAnalyticalDatabaseClient(DATABASE).append('t', []),
      );
      expect(authorizations).toEqual(['Bearer scope:key']);
      await runInScope({ executor: undefined as never, runtimeParams: { ...runtimeParams, apiKey: undefined } }, () =>
        expect(createAnalyticalDatabaseClient(DATABASE).append('t', [])).rejects.toThrow(/workflow-only/),
      );
      process.env.SOLIDACTIONS_API_URL = `${url}/api/internal`;
      process.env.SOLIDACTIONS_API_KEY = 'env:key';
      await createAnalyticalDatabaseClient(DATABASE).append('t', []);
      expect(authorizations).toEqual(['Bearer scope:key', 'Bearer env:key']);
    } finally {
      srv.close();
    }
  });

  it.each([
    ['property order and nesting', [{ b: 1, a: [3, { d: 4, c: 5 }] }], [{ a: [3, { c: 5, d: 4 }], b: 1 }]],
    ['negative zero', [{ n: -0 }], [{ n: 0 }]],
    ['RFC number rendering', [{ n: 1e30, small: 0.000001 }], [{ small: 0.000001, n: 1e30 }]],
    ['Unicode', [{ text: '€😀' }], [{ text: '€😀' }]],
  ])('derives the same RFC 8785 digest for %s', async (_name, left, right) => {
    let seen = 0;
    let firstId: string | undefined;
    const { srv, url } = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      const sentId = field(sent, 'batch_id');
      if (seen++ === 0) firstId = sentId;
      else expect(sentId).toBe(firstId);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(ackReply(sentId)));
    });
    env(url);
    try {
      const db = createAnalyticalDatabaseClient(DATABASE);
      await db.append('t', left as Record<string, unknown>[]);
      await db.append('t', right as Record<string, unknown>[]);
    } finally {
      srv.close();
    }
  });

  it('rejects lone Unicode surrogates and invalid options before network I/O', async () => {
    env('http://127.0.0.1:1');
    const db = createAnalyticalDatabaseClient(DATABASE);
    await expect(db.append('t', [{ x: '\ud800' }])).rejects.toThrow(/lone surrogate/);
    await expect(db.append('t', [], { batchId: 'sa-reserved' })).rejects.toThrow(/reserved/);
    await expect(db.append('t', [], { timeoutMs: 0 })).rejects.toThrow(/positive finite integer/);
  });

  it('reissues the same operation after retry_after_ms', async () => {
    const bodies: string[] = [];
    const { srv, url } = await server(async (req, res) => {
      bodies.push(await body(req));
      res.setHeader('content-type', 'application/json');
      if (bodies.length === 1) {
        res.statusCode = 429;
        res.end(JSON.stringify({ code: 'too_many_batches', retry_after_ms: 1 }));
        return;
      }
      const sent = jsonObject(bodies[1]);
      res.end(JSON.stringify(ackReply(field(sent, 'batch_id'))));
    });
    env(url);
    try {
      await createAnalyticalDatabaseClient(DATABASE).append('t', []);
      expect(bodies[1]).toBe(bodies[0]);
    } finally {
      srv.close();
    }
  });

  it('recovers a lost inline reply through status without replaying ingest', async () => {
    const operations: string[] = [];
    const bodies: string[] = [];
    const { srv, url } = await server(async (req, res) => {
      operations.push(req.url!.split('/').pop()!);
      bodies.push(await body(req));
      res.setHeader('content-type', 'application/json');
      if (operations.length === 1) {
        res.destroy();
        return;
      }
      const sent = jsonObject(bodies[0]);
      res.end(JSON.stringify(ackReply(field(sent, 'batch_id'), { rows: 1 })));
    });
    env(url);
    try {
      await createAnalyticalDatabaseClient(DATABASE).append('events', [{ id: 1 }]);
      expect(operations).toEqual(['ingest', 'ingest_status']);
      expect(jsonObject(bodies[1])).toEqual({ batch_id: field(jsonObject(bodies[0]), 'batch_id') });
    } finally {
      srv.close();
    }
  });

  it('does not invent a recovery code when status returns an HTTP error', async () => {
    const operations: string[] = [];
    const bodies: string[] = [];
    const { srv, url } = await server(async (req, res) => {
      operations.push(req.url!.split('/').pop()!);
      bodies.push(await body(req));
      res.setHeader('content-type', 'application/json');
      if (operations.length === 1) {
        res.destroy();
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'batch_not_found' }));
    });
    env(url);
    try {
      await expect(
        createAnalyticalDatabaseClient(DATABASE).replace(' Events ', [{ z: 1, a: 2 }]),
      ).rejects.toMatchObject({ code: 'batch_not_found', status: 404 });
      expect(operations).toEqual(['ingest', 'ingest_status']);
    } finally {
      srv.close();
    }
  });

  it('recovers a lost prepare at prepared by repreparing, uploading, and committing', async () => {
    const operations: string[] = [];
    const apiBodies: string[] = [];
    let uploads = 0;
    const upload = await server(async (req, res) => {
      await body(req);
      uploads++;
      res.end();
    });
    const api = await server(async (req, res) => {
      const operation = req.url!.split('/').pop()!;
      const raw = await body(req);
      operations.push(operation);
      apiBodies.push(raw);
      res.setHeader('content-type', 'application/json');
      if (operations.length === 1) {
        res.destroy();
        return;
      }
      const id = field(jsonObject(apiBodies[0]), 'batch_id');
      if (operation === 'ingest_status') res.end(JSON.stringify({ batch_id: id, state: 'prepared' }));
      else if (operation === 'ingest_prepare')
        res.end(JSON.stringify({ batch_id: id, upload_url: `${upload.url}/put`, upload_headers: {} }));
      else res.end(JSON.stringify(ackReply(id)));
    });
    env(api.url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-recovery-'));
    const path = join(dir, 'events.csv');
    await writeFile(path, 'id\n1\n');
    try {
      await createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path);
      expect(operations).toEqual(['ingest_prepare', 'ingest_status', 'ingest_prepare', 'ingest_commit']);
      expect(apiBodies[2]).toBe(apiBodies[0]);
      expect(uploads).toBe(1);
    } finally {
      api.srv.close();
      upload.srv.close();
    }
  });

  it('waits from a lost prepare when status reports a later state', async () => {
    const operations: string[] = [];
    let statusCalls = 0;
    const { srv, url } = await server(async (req, res) => {
      const operation = req.url!.split('/').pop()!;
      operations.push(operation);
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      if (operation === 'ingest_prepare') {
        res.destroy();
        return;
      }
      statusCalls++;
      res.end(
        JSON.stringify(
          statusCalls === 1
            ? { batch_id: field(sent, 'batch_id'), state: 'copying' }
            : ackReply(field(sent, 'batch_id')),
        ),
      );
    });
    env(url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-recovery-'));
    const path = join(dir, 'events.csv');
    await writeFile(path, 'id\n1\n');
    try {
      await createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path);
      expect(operations).toEqual(['ingest_prepare', 'ingest_status', 'ingest_status']);
    } finally {
      srv.close();
    }
  });

  it.each(['lost commit reply', 'prepared commit reply', 'later prepared status'])(
    'recommits the exact commit body for %s',
    async (scenario) => {
      const operations: string[] = [];
      const bodies: string[] = [];
      let statusCalls = 0;
      const upload = await server(async (req, res) => {
        await body(req);
        res.end();
      });
      const api = await server(async (req, res) => {
        const operation = req.url!.split('/').pop()!;
        const raw = await body(req);
        operations.push(operation);
        bodies.push(raw);
        res.setHeader('content-type', 'application/json');
        const id = field(jsonObject(bodies[0]), 'batch_id');
        if (operation === 'ingest_prepare') {
          res.end(JSON.stringify({ batch_id: id, upload_url: `${upload.url}/put`, upload_headers: {} }));
          return;
        }
        if (operation === 'ingest_commit' && operations.filter((value) => value === 'ingest_commit').length === 1) {
          if (scenario === 'lost commit reply') {
            res.destroy();
            return;
          }
          res.end(
            JSON.stringify({ batch_id: id, state: scenario === 'prepared commit reply' ? 'prepared' : 'copying' }),
          );
          return;
        }
        if (operation === 'ingest_status') {
          statusCalls++;
          const state =
            scenario === 'later prepared status' && statusCalls === 1
              ? 'prepared'
              : scenario === 'lost commit reply'
                ? 'prepared'
                : 'acked';
          res.end(JSON.stringify(state === 'acked' ? ackReply(id) : { batch_id: id, state }));
          return;
        }
        res.end(JSON.stringify(ackReply(id)));
      });
      env(api.url);
      const dir = await mkdtemp(join(tmpdir(), 'sa-recovery-'));
      const path = join(dir, 'events.csv');
      await writeFile(path, 'id\n1\n');
      try {
        await createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path);
        const commitBodies = bodies.filter((_body, index) => operations[index] === 'ingest_commit');
        expect(commitBodies).toHaveLength(2);
        expect(commitBodies[1]).toBe(commitBodies[0]);
        expect(Object.keys(jsonObject(commitBodies[0]))).toEqual(['batch_id']);
      } finally {
        api.srv.close();
        upload.srv.close();
      }
    },
  );

  it('backs off and bounds repeated prepared commit replies by the overall deadline', async () => {
    const operations: string[] = [];
    const commitTimes: number[] = [];
    const upload = await server(async (req, res) => {
      await body(req);
      res.end();
    });
    const api = await server(async (req, res) => {
      const operation = req.url!.split('/').pop()!;
      operations.push(operation);
      if (operation === 'ingest_commit') commitTimes.push(performance.now());
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      if (operation === 'ingest_prepare') {
        res.end(
          JSON.stringify({ batch_id: field(sent, 'batch_id'), upload_url: `${upload.url}/put`, upload_headers: {} }),
        );
      } else {
        res.end(JSON.stringify({ batch_id: field(sent, 'batch_id'), state: 'prepared' }));
      }
    });
    env(api.url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-prepared-deadline-'));
    const path = join(dir, 'events.csv');
    await writeFile(path, 'id\n1\n');
    const random = jest.spyOn(Math, 'random').mockReturnValue(1);
    try {
      await expect(
        createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path, { timeoutMs: 850 }),
      ).rejects.toMatchObject({ code: 'ingest_pending', lastState: 'prepared' });
      const commits = operations.filter((operation) => operation === 'ingest_commit');
      expect(commits.length).toBeGreaterThanOrEqual(3);
      expect(commits.length).toBeLessThanOrEqual(4);
      expect(commitTimes[1] - commitTimes[0]).toBeGreaterThanOrEqual(200);
      expect(commitTimes[2] - commitTimes[1]).toBeGreaterThanOrEqual(400);
    } finally {
      random.mockRestore();
      api.srv.close();
      upload.srv.close();
    }
  });

  it.each([
    ['acked', 'resolve'],
    ['failed', 'reject'],
    ['outcome_unknown', 'wait'],
  ])('handles A.5 %s as %s', async (state, behavior) => {
    let statusCalls = 0;
    const { srv, url } = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      if (req.url!.endsWith('/ingest')) {
        const id = field(sent, 'batch_id');
        res.end(
          JSON.stringify(
            state === 'acked'
              ? ackReply(id)
              : { batch_id: id, state, ...(state === 'failed' ? { error_code: 'schema_mismatch' } : {}) },
          ),
        );
        return;
      }
      statusCalls++;
      res.end(JSON.stringify(ackReply(field(sent, 'batch_id'))));
    });
    env(url);
    try {
      const promise = createAnalyticalDatabaseClient(DATABASE).append('t', []);
      if (behavior === 'reject')
        await expect(promise).rejects.toMatchObject({ code: 'schema_mismatch', lastState: 'failed' });
      else await expect(promise).resolves.toMatchObject({ state: 'acked' });
      expect(statusCalls).toBe(behavior === 'wait' ? 1 : 0);
    } finally {
      srv.close();
    }
  });

  it('does not upload after a prepare batch_conflict', async () => {
    let uploads = 0;
    const { srv, url } = await server(async (req, res) => {
      await body(req);
      uploads++;
      res.statusCode = 409;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 'batch_conflict' }));
    });
    env(url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-recovery-'));
    const path = join(dir, 'events.csv');
    await writeFile(path, 'id\n1\n');
    try {
      await expect(createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path)).rejects.toMatchObject({
        code: 'batch_conflict',
      });
      expect(uploads).toBe(1);
    } finally {
      srv.close();
    }
  });

  it('sanitises staged upload transport errors', async () => {
    const secretUrl = 'http://127.0.0.1:1/private-presigned-token';
    const { srv, url } = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ batch_id: field(sent, 'batch_id'), upload_url: secretUrl, upload_headers: {} }));
    });
    env(url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-recovery-'));
    const path = join(dir, 'events.csv');
    await writeFile(path, 'id\n1\n');
    try {
      const error = await createAnalyticalDatabaseClient(DATABASE)
        .ingestFile('events', path)
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: 'upload_failed' });
      expect(String(error)).not.toContain(secretUrl);
      expect(JSON.stringify(error)).not.toContain(secretUrl);
    } finally {
      srv.close();
    }
  });

  it('replays the exact prepare and commit operations after retry_after_ms', async () => {
    const operations: string[] = [];
    const bodies: string[] = [];
    const counts = new Map<string, number>();
    const upload = await server(async (req, res) => {
      await body(req);
      res.end();
    });
    const api = await server(async (req, res) => {
      const operation = req.url!.split('/').pop()!;
      const raw = await body(req);
      operations.push(operation);
      bodies.push(raw);
      const count = (counts.get(operation) ?? 0) + 1;
      counts.set(operation, count);
      res.setHeader('content-type', 'application/json');
      if (count === 1) {
        res.statusCode = 429;
        res.end(JSON.stringify({ code: 'overloaded', retry_after_ms: 1 }));
        return;
      }
      const id = field(jsonObject(raw), 'batch_id');
      if (operation === 'ingest_prepare')
        res.end(JSON.stringify({ batch_id: id, upload_url: `${upload.url}/put`, upload_headers: {} }));
      else res.end(JSON.stringify(ackReply(id)));
    });
    env(api.url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-recovery-'));
    const path = join(dir, 'events.csv');
    await writeFile(path, 'id\n1\n');
    try {
      await createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path);
      expect(operations).toEqual(['ingest_prepare', 'ingest_prepare', 'ingest_commit', 'ingest_commit']);
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[3]).toBe(bodies[2]);
    } finally {
      api.srv.close();
      upload.srv.close();
    }
  });

  it('bounds a hanging API fetch by the single deadline', async () => {
    const { srv, url } = await server(async (req) => {
      await body(req);
    });
    env(url);
    try {
      await expect(createAnalyticalDatabaseClient(DATABASE).append('t', [], { timeoutMs: 20 })).rejects.toMatchObject({
        code: 'ingest_pending',
      });
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  });

  it('preserves native user cancellation during an API fetch', async () => {
    const { srv, url } = await server(async (req) => {
      await body(req);
    });
    env(url);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    try {
      await expect(
        createAnalyticalDatabaseClient(DATABASE).append('t', [], { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  });

  it('cancels file hashing before prepare network I/O', async () => {
    let calls = 0;
    const { srv, url } = await server((_req, res) => {
      calls++;
      res.end();
    });
    env(url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-hash-abort-'));
    const path = join(dir, 'large.csv');
    await writeFile(path, '');
    await truncate(path, 200 * 1024 * 1024);
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    try {
      await expect(
        createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toBe(0);
    } finally {
      srv.close();
    }
  });

  it('applies timeoutMs while hashing and never calls prepare', async () => {
    let calls = 0;
    const { srv, url } = await server((_req, res) => {
      calls++;
      res.end();
    });
    env(url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-hash-timeout-'));
    const path = join(dir, 'large.csv');
    await writeFile(path, '');
    await truncate(path, 200 * 1024 * 1024);
    try {
      await expect(
        createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path, { timeoutMs: 1 }),
      ).rejects.toMatchObject({ code: 'ingest_pending' });
      expect(calls).toBe(0);
    } finally {
      srv.close();
    }
  });

  it('cancels an in-flight staged upload', async () => {
    const upload = await server((_req) => {
      /* deliberately retain backpressure */
    });
    const controller = new AbortController();
    const api = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ batch_id: field(sent, 'batch_id'), upload_url: `${upload.url}/put`, upload_headers: {} }),
      );
      setTimeout(() => controller.abort(), 20);
    });
    env(api.url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-upload-abort-'));
    const path = join(dir, 'large.csv');
    await writeFile(path, '');
    await truncate(path, 32 * 1024 * 1024);
    try {
      await expect(
        createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      upload.srv.closeAllConnections();
      api.srv.close();
      upload.srv.close();
    }
  });

  it('applies timeoutMs to a stalled upload and preserves the derived batch id', async () => {
    const upload = await server((_req) => {
      /* deliberately never respond */
    });
    let preparedId = '';
    const api = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      preparedId = field(sent, 'batch_id');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ batch_id: preparedId, upload_url: `${upload.url}/private-signed-token`, upload_headers: {} }),
      );
    });
    env(api.url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-upload-timeout-'));
    const path = join(dir, 'events.csv');
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 97));
    try {
      const error: unknown = await createAnalyticalDatabaseClient(DATABASE)
        .ingestFile('events', path, { timeoutMs: 50 })
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: 'ingest_pending', batchId: preparedId });
      expect(String(error)).not.toContain('private-signed-token');
    } finally {
      upload.srv.closeAllConnections();
      api.srv.close();
      upload.srv.close();
    }
  });

  it('cancels polling with the native abort error', async () => {
    const { srv, url } = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ batch_id: field(sent, 'batch_id'), state: 'copying' }));
    });
    env(url);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    try {
      await expect(
        createAnalyticalDatabaseClient(DATABASE).append('t', [], { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      srv.close();
    }
  });

  it('reports a polling deadline as pending with batchId and lastState', async () => {
    let batchId = '';
    const { srv, url } = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      batchId = field(sent, 'batch_id');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ batch_id: batchId, state: 'copying' }));
    });
    env(url);
    try {
      const error: unknown = await createAnalyticalDatabaseClient(DATABASE)
        .append('t', [], { timeoutMs: 20 })
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: 'ingest_pending', batchId, lastState: 'copying' });
    } finally {
      srv.close();
    }
  });

  it('canonicalises rows, derives a stable id, and sends identical canonical row bytes', async () => {
    const requests: Array<{ url: string; auth?: string; raw: string }> = [];
    const { srv, url } = await server(async (req, res) => {
      const raw = await body(req);
      requests.push({ url: req.url!, auth: req.headers.authorization, raw });
      const sent = jsonObject(raw);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          batch_id: field(sent, 'batch_id'),
          state: 'acked',
          rows: 1,
          durable: true,
          live_bytes: 9,
          acked_at: 'now',
        }),
      );
    });
    env(url);
    try {
      const db = createAnalyticalDatabaseClient(DATABASE);
      const one = await db.append(' Events ', [{ z: -0, a: { y: 2, x: 1 } }]);
      const two = await db.append('events', [{ a: { x: 1, y: 2 }, z: 0 }]);
      expect(one.batchId).toBe(two.batchId);
      expect(one.batchId).toBe('a68b22fbbb3705c3262fa683c4415eaa');
      expect(one.batchId).toMatch(/^[a-f0-9]{32}$/);
      expect(requests[0].url).toBe(`/api/internal/analytical-databases/${DATABASE}/ingest`);
      expect(requests[0].auth).toBe('Bearer run:key');
      expect(requests[0].raw).toContain('"rows":[{"a":{"x":1,"y":2},"z":0}]');
      expect(Object.keys(jsonObject(requests[0].raw)).sort()).toEqual(['batch_id', 'mode', 'rows', 'table']);
    } finally {
      srv.close();
    }
  });

  it.each([
    BigInt(1),
    undefined,
    Infinity,
    -Infinity,
    NaN,
    () => 1,
    Symbol('x'),
    Buffer.from('x'),
    new Uint8Array([1]),
    new Map(),
    new Set(),
    new (class X {
      a = 1;
    })(),
  ])('rejects non-JSON input before network I/O: %p', async (bad) => {
    env('http://127.0.0.1:1');
    await expect(createAnalyticalDatabaseClient(DATABASE).append('t', [{ bad }])).rejects.toThrow(/JSON/);
  });

  it('streams incrementally with exact returned checksum headers, fixed length, and no transfer encoding', async () => {
    const uploads: {
      length?: string;
      transfer?: string;
      sha?: string | string[];
      type?: string;
      chunks: number;
      bytes: number;
      rawHeaders: string[];
    }[] = [];
    let apiUrl = '';
    const upload = await server(async (req, res) => {
      let chunks = 0;
      let bytes = 0;
      for await (const chunk of req) {
        chunks++;
        bytes += Buffer.byteLength(chunk as Uint8Array);
      }
      uploads.push({
        length: req.headers['content-length'],
        transfer: req.headers['transfer-encoding'],
        sha: req.headers['x-amz-checksum-sha256'],
        type: req.headers['content-type'],
        chunks,
        bytes,
        rawHeaders: req.rawHeaders,
      });
      res.statusCode = 200;
      res.end();
    });
    const api = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      if (req.url!.endsWith('/ingest_prepare')) {
        const checksum = Buffer.from(field(sent, 'content_sha256'), 'hex').toString('base64');
        res.end(
          JSON.stringify({
            batch_id: field(sent, 'batch_id'),
            upload_url: `${upload.url}/put`,
            upload_headers: { 'X-Amz-Checksum-Sha256': checksum, 'Content-Type': 'text/csv' },
          }),
        );
      } else if (req.url!.endsWith('/ingest_commit')) {
        res.end(
          JSON.stringify({
            batch_id: field(sent, 'batch_id'),
            state: 'acked',
            rows: 2,
            durable: true,
            live_bytes: 11,
            acked_at: 'now',
          }),
        );
      }
    });
    apiUrl = api.url;
    env(apiUrl);
    const dir = await mkdtemp(join(tmpdir(), 'sa-ingest-'));
    const path = join(dir, 'events.csv');
    const contents = Buffer.alloc(2 * 1024 * 1024, 97);
    await writeFile(path, contents);
    try {
      await createAnalyticalDatabaseClient(DATABASE).ingestFile('events', path);
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toMatchObject({
        length: String(contents.length),
        transfer: undefined,
        type: 'text/csv',
        bytes: contents.length,
      });
      expect(uploads[0].sha).toBe(createHash('sha256').update(contents).digest('base64'));
      expect(uploads[0].chunks).toBeGreaterThan(1);
      expect(uploads[0].rawHeaders).toEqual(
        expect.arrayContaining(['X-Amz-Checksum-Sha256', 'Content-Type', 'Content-Length']),
      );
    } finally {
      api.srv.close();
      upload.srv.close();
    }
  });

  it('pins the ingest_prepare wire body and staged-file digest batch id', async () => {
    let prepare: Record<string, unknown> = {};
    const upload = await server(async (req, res) => {
      await body(req);
      res.end();
    });
    const api = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      if (req.url!.endsWith('/ingest_prepare')) {
        prepare = sent;
        res.end(
          JSON.stringify({ batch_id: field(sent, 'batch_id'), upload_url: `${upload.url}/put`, upload_headers: {} }),
        );
      } else {
        res.end(JSON.stringify(ackReply(field(sent, 'batch_id'))));
      }
    });
    env(api.url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-prepare-golden-'));
    const path = join(dir, 'events.csv');
    await writeFile(path, 'id\n1\n');
    try {
      const result = await createAnalyticalDatabaseClient(DATABASE).ingestFile(' Events ', path);
      expect(prepare).toEqual({
        table: 'events',
        mode: 'append',
        batch_id: '4cdc8e1d110ecbd7e08e88de8444f9ff',
        format: 'csv',
        declared_bytes: 5,
        content_sha256: '7cde7fb64fd82bd152710cf238e017b9ab46c0592483edc067ba4f6c75fac108',
      });
      expect(result.batchId).toBe('4cdc8e1d110ecbd7e08e88de8444f9ff');
    } finally {
      api.srv.close();
      upload.srv.close();
    }
  });

  it('uploads a 200 MiB sparse file in a constrained-heap subprocess without whole buffering', async () => {
    const fileSize = 200 * 1024 * 1024;
    let uploadedBytes = 0;
    let uploadChunks = 0;
    const upload = await server(async (req, res) => {
      for await (const chunk of req) {
        uploadChunks++;
        uploadedBytes += Buffer.byteLength(chunk as Uint8Array);
      }
      res.end();
    });
    const api = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/ingest_prepare')) {
        res.end(
          JSON.stringify({ batch_id: field(sent, 'batch_id'), upload_url: `${upload.url}/sparse`, upload_headers: {} }),
        );
      } else {
        res.end(JSON.stringify(ackReply(field(sent, 'batch_id'))));
      }
    });
    const dir = await mkdtemp(join(tmpdir(), 'sa-constrained-'));
    const path = join(dir, 'large.csv');
    await writeFile(path, '');
    await truncate(path, fileSize);
    const script = `const {createAnalyticalDatabaseClient}=require('./dist/src');createAnalyticalDatabaseClient('${DATABASE}').ingestFile('events',process.argv[1]).then(()=>{},error=>{console.error(error?.name,error?.code);process.exitCode=1})`;
    try {
      await execFileAsync(process.execPath, ['--max-old-space-size=64', '-e', script, path], {
        cwd: process.cwd(),
        env: { ...process.env, SOLIDACTIONS_API_URL: `${api.url}/api/internal`, SOLIDACTIONS_API_KEY: 'run:key' },
        maxBuffer: 1024 * 1024,
      });
      expect(uploadedBytes).toBe(fileSize);
      expect(uploadChunks).toBeGreaterThan(1);
    } finally {
      api.srv.close();
      upload.srv.close();
    }
  }, 30_000);

  it('preserves structured server failures', async () => {
    const { srv, url } = await server((_req, res) => {
      res.statusCode = 402;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 'insufficient_credit', message: 'no credit', details: { required: 12 } }));
    });
    env(url);
    try {
      await expect(createAnalyticalDatabaseClient(DATABASE).append('t', [])).rejects.toMatchObject<
        Partial<AnalyticalIngestError>
      >({ code: 'insufficient_credit', status: 402 });
    } finally {
      srv.close();
    }
  });

  it.each([
    ['kind_mismatch', 409, 'This database is Standard · SQLite; use createDatabaseClient instead.'],
    ['read_only', 403, 'Analytical databases are read-only over SQL; load data with ingest.'],
    ['storage_exhausted', 403, 'This analytical database has reached its storage limit.'],
    ['schema_mismatch', 422, 'Column total is DOUBLE, but the incoming value is VARCHAR.'],
    ['insufficient_credit', 402, 'Add credits or wait for the next billing period before waking this database.'],
  ])('preserves the %s rejection as a typed teaching error', async (code, status, message) => {
    const { srv, url } = await server((_req, res) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code, message }));
    });
    env(url);
    try {
      const error: unknown = await createAnalyticalDatabaseClient(DATABASE)
        .append('t', [])
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(AnalyticalIngestError);
      expect(error).toMatchObject({ code, status, message });
    } finally {
      srv.close();
    }
  });

  it.each([
    ['missing batch_id', { state: 'acked', rows: 1, durable: true, live_bytes: 2, acked_at: 'now' }],
    ['wrong batch_id', ackReply('different-batch')],
    ['missing rows', { batch_id: 'b', state: 'acked', durable: true, live_bytes: 2, acked_at: 'now' }],
    ['non-numeric rows', ackReply('b', { rows: '1' })],
    ['durable false', ackReply('b', { durable: false })],
    ['missing live_bytes', { batch_id: 'b', state: 'acked', rows: 1, durable: true, acked_at: 'now' }],
    ['missing acked_at', { batch_id: 'b', state: 'acked', rows: 1, durable: true, live_bytes: 2 }],
  ])('fails closed on an acked response with %s', async (_case, response) => {
    const { srv, url } = await server((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
    env(url);
    try {
      const error: unknown = await createAnalyticalDatabaseClient(DATABASE)
        .append('t', [], { batchId: 'b' })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(AnalyticalIngestError);
      expect(error).toMatchObject({ code: 'invalid_ingest_response', batchId: 'b' });
    } finally {
      srv.close();
    }
  });

  it.each([
    [
      'RFC 8785 numbers, Unicode, and negative zero',
      [{ numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27], unicode: '€$\u000f\nA\'B"\\"', z: -0 }],
      '[{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"unicode":"€$\\u000f\\nA\'B\\"\\\\\\"","z":0}]',
      'a41c3aa980ea066e6f48fedb41052f60',
    ],
    [
      'canonical integer-like property keys',
      [{ 10: 'ten', 2: 'two', 1: 'one', a: 'a' }],
      '[{"1":"one","10":"ten","2":"two","a":"a"}]',
      '0283eb7544791cb014d39c2723e795d3',
    ],
    [
      'Date toJSON strings',
      [{ at: new Date('2020-01-02T03:04:05.000Z') }],
      '[{"at":"2020-01-02T03:04:05.000Z"}]',
      '4f5414d362be58d222923f0140a29a0b',
    ],
  ])('pins canonical bytes and default batch id for %s', async (_label, rows, canonicalRows, expectedId) => {
    let raw = '';
    const { srv, url } = await server(async (req, res) => {
      raw = await body(req);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(ackReply(expectedId)));
    });
    env(url);
    try {
      const result = await createAnalyticalDatabaseClient(DATABASE).append('t', rows);
      expect(result.batchId).toBe(expectedId);
      expect(raw).toContain(`"rows":${canonicalRows}`);
      expect(field(jsonObject(raw), 'batch_id')).toBe(expectedId);
    } finally {
      srv.close();
    }
  });

  it('accepts exactly inline_batch_max_bytes=5,242,880 bytes (5 MiB) and rejects one byte over', async () => {
    const limit = 5_242_880;
    let calls = 0;
    let received = 0;
    const { srv, url } = await server(async (req, res) => {
      calls++;
      const raw = await body(req);
      received = Buffer.byteLength(raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(ackReply(field(jsonObject(raw), 'batch_id'))));
    });
    env(url);
    const emptyBody = '{"table":"t","mode":"append","batch_id":"b","rows":[{"x":""}]}';
    const atLimit = 'x'.repeat(limit - Buffer.byteLength(emptyBody));
    try {
      await createAnalyticalDatabaseClient(DATABASE).append('t', [{ x: atLimit }], { batchId: 'b' });
      expect(received).toBe(limit);
      await expect(
        createAnalyticalDatabaseClient(DATABASE).append('t', [{ x: `${atLimit}x` }], { batchId: 'b' }),
      ).rejects.toMatchObject({
        code: 'inline_batch_too_large',
        message: 'Inline analytical ingest exceeds inline_batch_max_bytes=5,242,880 bytes (5 MiB)',
      });
      expect(calls).toBe(1);
    } finally {
      srv.close();
    }
  });

  it('rejects sparse arrays, symbol keys, and lone-surrogate object keys before transport', async () => {
    env('http://127.0.0.1:1');
    const sparse: unknown[] = [];
    sparse.length = 1;
    const symbolKeyed: Record<string, unknown> = {};
    symbolKeyed[Symbol('hidden') as unknown as string] = true;
    const surrogateKey = { ['\ud800']: true };
    const db = createAnalyticalDatabaseClient(DATABASE);
    await expect(db.append('t', [{ value: sparse }])).rejects.toThrow(/sparse arrays/);
    await expect(db.append('t', [symbolKeyed])).rejects.toThrow(/symbol keys/);
    await expect(db.append('t', [surrogateKey])).rejects.toThrow(/lone surrogate/);
  });

  it.each(['notaurl', 'file:///private/signed-secret', 'ftp://example.test/private/signed-secret'])(
    'sanitises malformed or unsupported upload URL %s',
    async (uploadUrl) => {
      const { srv, url } = await server(async (req, res) => {
        const sent = jsonObject(await body(req));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ batch_id: field(sent, 'batch_id'), upload_url: uploadUrl, upload_headers: {} }));
      });
      env(url);
      const dir = await mkdtemp(join(tmpdir(), 'sa-url-'));
      const path = join(dir, 'events.csv');
      await writeFile(path, 'id\n1\n');
      try {
        const error: unknown = await createAnalyticalDatabaseClient(DATABASE)
          .ingestFile('events', path)
          .catch((reason: unknown) => reason);
        expect(error).toMatchObject({ code: 'upload_failed' });
        expect(String(error)).not.toContain(uploadUrl);
        expect(JSON.stringify(error)).not.toContain(uploadUrl);
      } finally {
        srv.close();
      }
    },
  );

  it('sanitises a non-2xx staged upload while preserving its HTTP status', async () => {
    const signedUrl = 'http://127.0.0.1/private-signed-token';
    const upload = await server(async (req, res) => {
      await body(req);
      res.statusCode = 503;
      res.end('secret upstream body');
    });
    const actualSignedUrl = `${upload.url}/private-signed-token`;
    const api = await server(async (req, res) => {
      const sent = jsonObject(await body(req));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ batch_id: field(sent, 'batch_id'), upload_url: actualSignedUrl, upload_headers: {} }));
    });
    env(api.url);
    const dir = await mkdtemp(join(tmpdir(), 'sa-upload-status-'));
    const path = join(dir, 'events.csv');
    await writeFile(path, 'id\n1\n');
    try {
      const error: unknown = await createAnalyticalDatabaseClient(DATABASE)
        .ingestFile('events', path)
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: 'upload_failed', status: 503 });
      expect(String(error)).not.toContain(actualSignedUrl);
      expect(JSON.stringify(error)).not.toContain(actualSignedUrl);
      expect(String(error)).not.toContain(signedUrl);
    } finally {
      api.srv.close();
      upload.srv.close();
    }
  });
});
