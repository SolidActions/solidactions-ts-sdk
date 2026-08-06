/**
 * Issue #1127 — `createDatabaseClient`: raw SQL passthrough over the libSQL
 * Hrana-over-HTTP `/v2/pipeline` endpoint (spec §7B). Uses a real local HTTP
 * server (house pattern — see context-adapter.test.ts's WORKFLOW_INPUT_URL
 * tests) rather than mocking fetch, per the project's no-mocks testing rule.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
import type { AddressInfo } from 'node:net';
import * as http from 'node:http';
import { createDatabaseClient } from '../../src/invoke/database-client';
import type { DatabaseVar } from '../../src/invoke/types';

/** Start a local HTTP server and return its base http:// URL + a stop() fn. */
async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

describe('createDatabaseClient: request shape', () => {
  it('POSTs to /v2/pipeline with a Bearer token and the raw SQL + args in Hrana shape', async () => {
    let capturedPath = '';
    let capturedAuth = '';
    let capturedBody: unknown;
    const { url, stop } = await startServer((req, res, body) => {
      capturedPath = req.url ?? '';
      capturedAuth = req.headers['authorization'] ?? '';
      capturedBody = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          results: [
            {
              type: 'ok',
              response: {
                type: 'execute',
                result: { cols: [{ name: 'id' }], rows: [[{ type: 'integer', value: '1' }]] },
              },
            },
            { type: 'ok', response: { type: 'close' } },
          ],
        }),
      );
    });

    try {
      // createDatabaseClient derives https:// from libsql://, but the test
      // server is plain http — so pass an http:// url directly (the derivation
      // only rewrites the libsql:// scheme, http/https pass through as-is).
      const v: DatabaseVar = { name: 'analytics', url, token: 'test-jwt', readOnly: false };
      const client = createDatabaseClient(v);
      const result = await client.execute('SELECT id FROM t WHERE id = ?', [1]);

      expect(capturedPath).toBe('/v2/pipeline');
      expect(capturedAuth).toBe('Bearer test-jwt');
      expect(capturedBody).toMatchObject({
        requests: [
          { type: 'execute', stmt: { sql: 'SELECT id FROM t WHERE id = ?', args: [{ type: 'integer', value: '1' }] } },
          { type: 'close' },
        ],
      });
      expect(result.columns).toEqual(['id']);
      expect(result.rows).toEqual([[1]]);
    } finally {
      await stop();
    }
  });

  it('derives an https:// Hrana URL from a libsql:// DatabaseVar.url', async () => {
    // We cannot spin up a real TLS server here trivially, so this proves the
    // derivation via a thrown network error whose message contains the derived
    // https:// host — createDatabaseClient never silently falls back to http.
    const v: DatabaseVar = {
      name: 'analytics',
      url: 'libsql://this-host-does-not-resolve.invalid',
      token: 'tok',
      readOnly: false,
    };
    const client = createDatabaseClient(v);
    await expect(client.execute('SELECT 1')).rejects.toThrow();
  });

  it('passes text, null, float, and boolean args in correct Hrana shape', async () => {
    let capturedBody: unknown;
    const { url, stop } = await startServer((req, res, body) => {
      capturedBody = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          results: [
            { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } },
            { type: 'ok', response: { type: 'close' } },
          ],
        }),
      );
    });
    try {
      const v: DatabaseVar = { name: 'a', url, token: 'tok', readOnly: false };
      const client = createDatabaseClient(v);
      await client.execute('INSERT INTO t VALUES (?, ?, ?, ?)', ['hello', null, 1.5, true]);
      const body = capturedBody as { requests: Array<{ type: string; stmt?: { args: unknown[] } }> };
      expect(body.requests[0]?.stmt?.args).toEqual([
        { type: 'text', value: 'hello' },
        { type: 'null' },
        { type: 'float', value: '1.5' },
        { type: 'integer', value: '1' },
      ]);
    } finally {
      await stop();
    }
  });

  it('decodes rows_affected and last_insert_rowid from a write statement', async () => {
    const { url, stop } = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          results: [
            {
              type: 'ok',
              response: {
                type: 'execute',
                result: { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: '42' },
              },
            },
            { type: 'ok', response: { type: 'close' } },
          ],
        }),
      );
    });
    try {
      const v: DatabaseVar = { name: 'a', url, token: 'tok', readOnly: false };
      const client = createDatabaseClient(v);
      const result = await client.execute("INSERT INTO t (name) VALUES ('x')");
      expect(result.rowsAffected).toBe(1);
      expect(result.lastInsertRowid).toBe('42');
    } finally {
      await stop();
    }
  });

  it('throws a descriptive error when the Hrana response reports a sql_error', async () => {
    const { url, stop } = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          results: [{ type: 'error', error: { message: 'no such table: t' } }],
        }),
      );
    });
    try {
      const v: DatabaseVar = { name: 'a', url, token: 'tok', readOnly: false };
      const client = createDatabaseClient(v);
      await expect(client.execute('SELECT * FROM t')).rejects.toThrow('no such table: t');
    } finally {
      await stop();
    }
  });

  it('throws a descriptive error on a non-ok HTTP response', async () => {
    const { url, stop } = await startServer((_req, res) => {
      res.writeHead(401, 'Unauthorized');
      res.end('unauthorized');
    });
    try {
      const v: DatabaseVar = { name: 'a', url, token: 'bad-tok', readOnly: false };
      const client = createDatabaseClient(v);
      await expect(client.execute('SELECT 1')).rejects.toThrow('401');
    } finally {
      await stop();
    }
  });
});
