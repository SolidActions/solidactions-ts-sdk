/**
 * SolidActions.docs.create() — Track 3 (Sweep C, → 0.7.2).
 *
 * Auth is explicit config ONLY: a workspace API key (Sanctum PAT) +
 * X-Workspace-Id, never auto-read from reserved SOLIDACTIONS_* env vars
 * (context-adapter.ts's RESERVED_KEYS/isReserved already treats that prefix
 * as framework-owned). Users declare their own project env var name (e.g.
 * MY_SA_API_KEY) and pass the value in explicitly.
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer),
 * matching tests/http_client.test.ts / tests/http_mock_server.ts. No mock
 * libraries.
 */
import * as http from 'http';
import { createDoc } from '../src/docs';
import { SolidActionsDataValidationError, SolidActionsHttpError } from '../src/error';

let server: http.Server;
let baseUrl: string;
let lastRequest: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: any } | null = null;
let nextStatus = 201;
let nextBody: any = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* ignore */
      }
      lastRequest = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(nextStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextBody));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    }),
  );
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

beforeEach(() => {
  lastRequest = null;
  nextStatus = 201;
  nextBody = {
    doc: {
      id: 42,
      title: 'Runbook',
      folder_id: null,
      folder_path: null,
      body: 'hello',
      properties: [],
      doc_type: null,
      current_version_id: 1,
      body_blob_sha: 'deadbeef',
      created_at: '2026-07-04T00:00:00Z',
      updated_at: '2026-07-04T00:00:00Z',
    },
    warnings: [],
  };
});

describe('createDoc — validation (no network call on missing config)', () => {
  test('throws when config.apiKey is missing', async () => {
    await expect(createDoc({ title: 'x' }, { apiKey: '', workspaceId: 'ws-1', baseUrl })).rejects.toThrow(
      SolidActionsDataValidationError,
    );
    expect(lastRequest).toBeNull();
  });

  test('throws when config.workspaceId is missing', async () => {
    await expect(createDoc({ title: 'x' }, { apiKey: 'sk_test', workspaceId: '', baseUrl })).rejects.toThrow(
      SolidActionsDataValidationError,
    );
    expect(lastRequest).toBeNull();
  });

  test('throws when input.title is missing', async () => {
    await expect(createDoc({ title: '' }, { apiKey: 'sk_test', workspaceId: 'ws-1', baseUrl })).rejects.toThrow(
      /title/,
    );
    expect(lastRequest).toBeNull();
  });
});

describe('createDoc — request shape', () => {
  test('POSTs /docs with Authorization, X-Workspace-Id, and mapped body fields', async () => {
    const result = await createDoc(
      {
        title: 'Runbook',
        body: 'hello',
        properties: { owner: 'jordan' },
        folderPath: '/ops',
        parseFrontmatter: true,
      },
      { apiKey: 'sk_test', workspaceId: 'ws-123', baseUrl },
    );

    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.url).toBe('/api/v1/docs');
    expect(lastRequest?.headers['authorization']).toBe('Bearer sk_test');
    expect(lastRequest?.headers['x-workspace-id']).toBe('ws-123');
    expect(lastRequest?.body).toEqual({
      title: 'Runbook',
      body: 'hello',
      properties: { owner: 'jordan' },
      folder_path: '/ops',
      parse_frontmatter: true,
    });
    expect(result.doc.id).toBe(42);
    expect(result.warnings).toEqual([]);
  });

  test('sends Idempotency-Key header when input.idempotencyKey is set', async () => {
    await createDoc(
      { title: 'Runbook', idempotencyKey: 'idem-abc' },
      { apiKey: 'sk_test', workspaceId: 'ws-123', baseUrl },
    );
    expect(lastRequest?.headers['idempotency-key']).toBe('idem-abc');
  });
});

describe('createDoc — error mapping (reuses HttpClient conventions)', () => {
  test('a 422 from the server surfaces as a generic HTTP error with the server message', async () => {
    nextStatus = 422;
    nextBody = { message: "A doc titled 'Runbook' already exists.", code: 'duplicate_title' };
    await expect(
      createDoc({ title: 'Runbook' }, { apiKey: 'sk_test', workspaceId: 'ws-123', baseUrl }),
    ).rejects.toThrow(SolidActionsHttpError);
  });
});
