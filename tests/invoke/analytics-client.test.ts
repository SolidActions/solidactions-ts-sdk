/**
 * Task 9 (duckdb-w1, ts-sdk#25) — `openAnalytics`: the DuckDB database client.
 *
 * The app side is a real local HTTP server that implements the frozen
 * C-run-api contract (open / renew / upload_prepare / commit / release) plus
 * object PUT and GET with real behaviour: the PUT refuses (403) a request without the three signed headers
 * (Content-Length, x-amz-checksum-sha256, If-None-Match: *), enforces the signed
 * Content-Length and sha256, refuses a second PUT to the same key with 412, and
 * the GET serves the stored zstd bytes. Files are real temp files and the
 * compression is real zstd (`node:zlib`). The durable `step` primitive is the
 * production one: the closures `invoke()` builds over `InvokeSystemDatabase`,
 * talking to the SDK's own platform mock server (`createMockServer`). A replay
 * is a second dispatch of the same run id, so a replayed error comes back
 * through `serializeErrorWithCause` / `deserializeError` as a plain `Error`.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 */
import * as http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { AnalyticsError, openAnalytics } from '../../src/invoke/analytics-client';
import type { AnalyticsDatabase, OpenAnalyticsOptions } from '../../src/invoke/analytics-client';
import { defineWorkflow } from '../../src/invoke/define-workflow';
import { invoke } from '../../src/invoke/invoke';
import { runInScope } from '../../src/invoke/runtime-scope';
import type { RuntimeScope } from '../../src/invoke/runtime-scope';
import { SolidActionsJSON } from '../../src/serialization';
import { createMockServer } from '../../src/testing/mock_server';
import type { MockHttpServer } from '../../src/testing/mock_server';
import { makeCtx } from '../helpers';
import type { DurablePrimitives } from '../../src/invoke/types';

const DB = '123e4567-e89b-12d3-a456-426614174000';
const API_KEY = '77:analytical-bearer-secret';
const SIGNATURE = 'sig-abc123';
const FILE_NAME = 'sales.duckdb';

const zstdSync = (b: Buffer): Buffer =>
  (zlib as unknown as { zstdCompressSync(x: Buffer): Buffer }).zstdCompressSync(b);
const unzstdSync = (b: Buffer): Buffer =>
  (zlib as unknown as { zstdDecompressSync(x: Buffer): Buffer }).zstdDecompressSync(b);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A synthetic database file: 8 checksum bytes, `DUCK`, uint64 storage version, then patterned filler. */
function dbFile(size: number, storageVersion = 64): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 20; i < size; i++) b[i] = (i * 31 + (i >> 8) * 7) & 255;
  b.write('DUCK', 8, 'latin1');
  b.writeBigUInt64LE(BigInt(storageVersion), 12);
  return b;
}
const TEMPLATE = dbFile(12288);

interface Reply {
  status: number;
  body: unknown;
}
/** A scripted answer for one API call: a reply, a dropped socket, or "apply, then drop the socket". */
type Fault = Reply | 'drop' | 'drop-after';
interface PublishedVersion {
  id: string;
  seq: number | null;
  bytes: number;
  storedBytes: number;
  sha256: string;
}
interface Upload {
  id: string;
  purpose: string;
  storedBytes: number;
  sha256: string;
  bytes: number;
  version: PublishedVersion | null;
}
interface TestServer {
  url: string;
  apiUrl: string;
  calls: Array<{ op: string; body: Record<string, unknown> }>;
  puts: Array<{ key: string; length: number; status: number }>;
  published: PublishedVersion[];
  objects: Map<string, Buffer>;
  uploads: Map<string, Upload>;
  faults: Record<string, Fault[]>;
  putFaults: Array<'500' | 'store-then-drop' | '403-early'>;
  config: {
    ttlSeconds: number;
    capBytes: number;
    maxStorageVersion: number;
    fileName: string;
    corruptDownload: boolean;
    wrongStoredBytes: boolean;
    /** Makes the base version's `bytes` disagree with the stored object. */
    reportedBytes?: number;
  };
  publishFile(contents: Buffer): PublishedVersion;
  count(op: string): number;
  stop(): Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const published: PublishedVersion[] = [];
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Upload>();
  let save: PublishedVersion | null = null;
  let leaseBase: string | null | undefined;
  const ownPublishedFrom = new Set<string | null>();
  const state: TestServer = {
    url: '',
    apiUrl: '',
    calls: [],
    puts: [],
    published,
    objects,
    uploads,
    faults: {},
    putFaults: [],
    config: {
      ttlSeconds: 60,
      capBytes: 10_000_000,
      maxStorageVersion: 64,
      fileName: FILE_NAME,
      corruptDownload: false,
      wrongStoredBytes: false,
    },
    publishFile(contents) {
      const stored = zstdSync(contents);
      const version: PublishedVersion = {
        id: randomUUID(),
        seq: published.length + 1,
        bytes: contents.length,
        storedBytes: stored.length,
        sha256: sha(stored),
      };
      objects.set(version.id, stored);
      published.push(version);
      return version;
    },
    count: (op) => state.calls.filter((c) => c.op === op).length,
    stop: () => Promise.resolve(),
  };

  const signed = (key: string): string => `${state.url}/obj/${key}?X-Amz-Signature=${SIGNATURE}`;
  const wire = (v: PublishedVersion) => ({
    id: v.id,
    seq: v.seq,
    bytes: state.config.reportedBytes ?? v.bytes,
    stored_bytes: v.storedBytes + (state.config.wrongStoredBytes ? 1 : 0),
    sha256: v.sha256,
  });
  const committed = (v: PublishedVersion, purpose: string) => ({
    version: {
      id: v.id,
      seq: v.seq,
      state: purpose === 'publish' ? 'published' : 'saved',
      bytes: v.bytes,
      stored_bytes: v.storedBytes,
      published_at: purpose === 'publish' ? '2026-11-13T00:00:00Z' : null,
    },
  });

  function api(op: string, body: Record<string, unknown>): Reply {
    const latest = published[published.length - 1];
    switch (op) {
      case 'open': {
        const readOnly = body['read_only'] === true;
        if (readOnly && !latest) return { status: 409, body: { error: 'no_published_version', message: 'none' } };
        const expected = body['expected_base'] as { version_id: string | null } | undefined;
        if (
          !readOnly &&
          expected &&
          expected.version_id !== (latest?.id ?? null) &&
          !ownPublishedFrom.has(expected.version_id)
        ) {
          return {
            status: 409,
            body: {
              error: 'base_moved',
              message: 'server wording',
              latest_version_id: latest?.id ?? null,
              base_version_id: expected.version_id,
            },
          };
        }
        if (!readOnly && leaseBase === undefined) leaseBase = latest?.id ?? null;
        let base: unknown;
        if (!readOnly && save) {
          base = { kind: 'save_point', version: wire(save), url: signed(save.id), expires_at: '2026-11-13T01:00:00Z' };
        } else if (latest) {
          base = {
            kind: 'published',
            version: wire(latest),
            url: signed(latest.id),
            expires_at: '2026-11-13T01:00:00Z',
          };
        } else {
          base = {
            kind: 'empty',
            template_base64: TEMPLATE.toString('base64'),
            template_sha256: sha(TEMPLATE),
            bytes: 12288,
          };
        }
        return {
          status: 200,
          body: {
            database: { id: DB, name: 'sales', file_name: state.config.fileName },
            lease: readOnly
              ? null
              : {
                  expires_at: '2026-11-13T00:10:00Z',
                  ttl_seconds: state.config.ttlSeconds,
                  base_version_id: leaseBase,
                },
            limits: {
              cap_bytes: state.config.capBytes,
              max_storage_version_number: state.config.maxStorageVersion,
              storage_version_pin: 'v1.2.0',
            },
            base,
          },
        };
      }
      case 'renew':
        return {
          status: 200,
          body: { lease: { expires_at: '2026-11-13T00:20:00Z', ttl_seconds: state.config.ttlSeconds } },
        };
      case 'upload_prepare': {
        const id = randomUUID();
        uploads.set(id, {
          id,
          purpose: String(body['purpose']),
          bytes: Number(body['bytes']),
          storedBytes: Number(body['stored_bytes']),
          sha256: String(body['sha256']),
          version: null,
        });
        return {
          status: 200,
          body: {
            upload_id: id,
            url: signed(id),
            // The three headers the app's presigned PUT is signed with; the client must forward all of them.
            headers: {
              'Content-Length': String(body['stored_bytes']),
              'x-amz-checksum-sha256': Buffer.from(String(body['sha256']), 'hex').toString('base64'),
              'If-None-Match': '*',
            },
            expires_at: '2026-11-13T00:30:00Z',
          },
        };
      }
      case 'commit': {
        const up = uploads.get(String(body['upload_id']));
        if (!up) return { status: 404, body: { error: 'upload_not_found', message: 'unknown upload' } };
        if (!objects.has(up.id)) return { status: 422, body: { error: 'upload_missing', message: 'nothing uploaded' } };
        if (!up.version) {
          up.version = {
            id: up.id,
            seq: up.purpose === 'publish' ? published.length + 1 : null,
            bytes: up.bytes,
            storedBytes: up.storedBytes,
            sha256: up.sha256,
          };
          if (up.purpose === 'publish') {
            published.push(up.version);
            ownPublishedFrom.add(leaseBase ?? null);
            save = null;
            leaseBase = undefined;
          } else {
            save = up.version;
          }
        }
        return { status: 200, body: committed(up.version, up.purpose) };
      }
      case 'release':
        return { status: 200, body: { released: true } };
      default:
        return { status: 404, body: { error: 'unknown_operation', message: 'no such operation' } };
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'PUT' && state.putFaults[0] === '403-early') {
      // Sends a 403 whose body is promised but never finished, then drops the connection: the client has the status
      // from the headers, but its response is incomplete and its request body is still being written.
      state.putFaults.shift();
      state.puts.push({ key: '', length: 0, status: 403 });
      res.writeHead(403, { 'content-length': '1000' });
      res.write('x');
      return void setTimeout(() => req.socket.destroy(), 50);
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const target = new URL(req.url ?? '/', 'http://x');
      const objectMatch = /^\/obj\/([0-9a-f-]+)$/.exec(target.pathname);
      if (objectMatch) {
        const key = objectMatch[1] ?? '';
        if (req.method === 'GET') {
          const stored = objects.get(key);
          if (!stored) return void res.writeHead(404).end();
          const out = Buffer.from(stored);
          if (state.config.corruptDownload) out[Math.floor(out.length / 2)] ^= 0xff;
          return void res.writeHead(200, { 'content-length': out.length }).end(out);
        }
        const up = uploads.get(key);
        const record = (status: number) => state.puts.push({ key, length: raw.length, status });
        if (!up || target.searchParams.get('X-Amz-Signature') !== SIGNATURE) {
          record(403);
          return void res.writeHead(403).end();
        }
        const signedHeaders =
          req.headers['content-length'] === String(up.storedBytes) &&
          req.headers['x-amz-checksum-sha256'] === Buffer.from(up.sha256, 'hex').toString('base64') &&
          req.headers['if-none-match'] === '*';
        if (!signedHeaders) {
          record(403);
          return void res.writeHead(403).end();
        }
        const fault = state.putFaults.shift();
        if (fault === '500') {
          record(500);
          return void res.writeHead(500).end();
        }
        if (fault === 'store-then-drop') {
          objects.set(key, raw);
          record(0);
          return void req.socket.destroy();
        }
        if (objects.has(key)) {
          record(412);
          return void res.writeHead(412).end();
        }
        if (raw.length !== up.storedBytes || sha(raw) !== up.sha256) {
          record(400);
          return void res.writeHead(400).end();
        }
        objects.set(key, raw);
        record(200);
        return void res.writeHead(200).end();
      }
      const match = /^\/api\/internal\/duckdb-databases\/([^/]+)\/([a-z_]+)$/.exec(target.pathname);
      if (!match || req.method !== 'POST' || req.headers['authorization'] !== `Bearer ${API_KEY}`) {
        return void res.writeHead(401).end();
      }
      const op = match[2] ?? '';
      const body = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
      state.calls.push({ op, body });
      const fault = state.faults[op]?.shift();
      if (fault === 'drop') return void req.socket.destroy();
      const reply = fault && fault !== 'drop-after' ? fault : api(op, body);
      if (fault === 'drop-after') return void req.socket.destroy();
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.apiUrl = `${state.url}/api/internal`;
  state.stop = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return state;
}

let capturedPrimitives: DurablePrimitives | undefined;
/** A workflow whose body only keeps the primitives `invoke()` attached to its ctx. */
const captureWorkflow = defineWorkflow<null, null>({
  name: 'analytics-client-test-capture',
  run(ctx) {
    capturedPrimitives = { step: ctx.step, sleep: ctx.sleep, recv: ctx.recv, send: ctx.send };
    return Promise.resolve(null);
  },
});

/**
 * The production `step` primitive: the closures `invoke()` builds over `InvokeSystemDatabase`, bound to the platform
 * mock server. Asking again for the same `runUuid` is a re-dispatch of that run, so its recorded steps replay.
 */
async function prim(platform: MockHttpServer, runUuid: string): Promise<DurablePrimitives> {
  if (!platform.store.operations.has(runUuid)) {
    platform.store.workflows.set(runUuid, {
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
      applicationID: '',
      input: null,
      output: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      recoveryAttempts: 0,
      priority: 0,
    });
    platform.store.operations.set(runUuid, []);
  }
  capturedPrimitives = undefined;
  const result = await invoke(
    captureWorkflow,
    makeCtx(platform, {
      input: null,
      run: { triggerId: 'test-trigger', runUuid, runSecret: 's', workerSessionId: 'w' },
    }),
  );
  if (result.status !== 'completed' || !capturedPrimitives)
    throw new Error('could not build the production primitives');
  return capturedPrimitives;
}

/** The steps the platform has recorded for a run, in function-id order. */
function recordedSteps(platform: MockHttpServer, runUuid: string) {
  return [...(platform.store.operations.get(runUuid) ?? [])]
    .sort((x, y) => (x.functionId ?? 0) - (y.functionId ?? 0))
    .map((o) => ({
      name: o.functionName,
      output: o.output === null ? undefined : SolidActionsJSON.parse(o.output),
      error:
        o.error === null
          ? undefined
          : (SolidActionsJSON.parse(o.error) as { name?: string; message?: string; code?: string }),
    }));
}

function scopeFor(s: TestServer, primitives: DurablePrimitives | undefined): RuntimeScope {
  return {
    executor: undefined as never,
    runtimeParams: {
      workflowID: 'run-1',
      executorID: 'e',
      appId: 'a',
      appVersion: '1',
      apiUrl: s.apiUrl,
      apiKey: API_KEY,
      runSecret: 'secret',
      functionIDCounter: 0,
    },
    primitives,
  };
}

function inScope<T>(s: TestServer, primitives: DurablePrimitives | undefined, fn: () => Promise<T>): Promise<T> {
  return runInScope(scopeFor(s, primitives), fn);
}

/** A handle used the way a workflow body uses it: every call runs inside the scope the handle was opened in. */
function insideScope(db: AnalyticsDatabase, scope: RuntimeScope): AnalyticsDatabase {
  return {
    path: db.path,
    version: db.version,
    readOnly: db.readOnly,
    step: <T>(name: string, fn: () => T | Promise<T>) => runInScope(scope, () => db.step(name, fn)),
    save: () => runInScope(scope, () => db.save()),
    publish: () => runInScope(scope, () => db.publish()),
  };
}

async function failure(p: Promise<unknown>): Promise<AnalyticsError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof AnalyticsError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

/** What a replayed step throws: the error went through serialize/deserialize, so it is a plain Error carrying `code`. */
async function replayedFailure(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (error) {
    if (error instanceof Error) return error as Error & { code?: string };
    throw error;
  }
  throw new Error('expected the call to fail');
}

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('openAnalytics', () => {
  let s: TestServer;
  let platform: MockHttpServer;
  let tmp: string;
  let seq = 0;
  const dirFor = (label: string): string => path.join(tmp, `${label}-${seq++}`);
  const open = (
    primitives: DurablePrimitives | undefined,
    options: OpenAnalyticsOptions = {},
    binding = DB,
  ): Promise<AnalyticsDatabase> => {
    const scope = scopeFor(s, primitives);
    return runInScope(scope, () => openAnalytics(binding, { directory: dirFor('work'), ...options })).then((db) =>
      insideScope(db, scope),
    );
  };

  const primitives = (runUuid: string = randomUUID()): Promise<DurablePrimitives> => prim(platform, runUuid);
  const steps = (runUuid: string) => recordedSteps(platform, runUuid);

  beforeEach(async () => {
    platform = await createMockServer();
    s = await startServer();
    tmp = await mkdtemp(path.join(os.tmpdir(), 'analytics-test-'));
  });
  afterEach(async () => {
    await s.stop();
    await platform.stop();
    await rm(tmp, { recursive: true, force: true });
  });

  describe('open and restore', () => {
    it('opens a new database from the empty template into a 0700 work folder at version 0', async () => {
      const directory = dirFor('fresh');
      const db = await inScope(s, await primitives(), () => openAnalytics(DB, { directory }));

      expect(db.path).toBe(path.join(directory, FILE_NAME));
      expect(db.version).toBe(0);
      expect(db.readOnly).toBe(false);
      expect(await readFile(db.path)).toEqual(TEMPLATE);
      expect((await stat(db.path)).size).toBe(12288);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    });

    it('defaults the work folder to <tmpdir>/solidactions-analytics/<databaseId>', async () => {
      const defaultFolder = path.join(os.tmpdir(), 'solidactions-analytics', DB);
      try {
        const db = await inScope(s, await primitives(), () => openAnalytics(DB));
        expect(db.path).toBe(path.join(defaultFolder, FILE_NAME));
        expect((await stat(db.path)).size).toBe(12288);
      } finally {
        await rm(defaultFolder, { recursive: true, force: true });
      }
    });

    it('restores the newest published version, byte for byte, and reports its seq as the version', async () => {
      s.publishFile(dbFile(20000));
      const known = dbFile(50000);
      s.publishFile(known);

      const db = await open(await primitives());

      expect(db.version).toBe(2);
      expect(await readFile(db.path)).toEqual(known);
    });

    it('removes a stale write-ahead log left in the work folder when it restores', async () => {
      s.publishFile(dbFile(20000));
      const directory = dirFor('stale');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${FILE_NAME}.wal`), 'old wal');

      await inScope(s, await primitives(), () => openAnalytics(DB, { directory }));

      expect(existsSync(path.join(directory, `${FILE_NAME}.wal`))).toBe(false);
    });

    it('opens read-only without consuming a function id, sending expected_base or renewing a lease', async () => {
      s.config.ttlSeconds = 3;
      const known = dbFile(30000);
      s.publishFile(known);
      const run = randomUUID();

      const db = await open(await primitives(run), { readOnly: true });

      expect(db.readOnly).toBe(true);
      expect(db.version).toBe(1);
      expect(await readFile(db.path)).toEqual(known);
      expect(steps(run)).toEqual([]);
      expect(s.calls.map((c) => c.op)).toEqual(['open']);
      expect(s.calls[0]?.body).toEqual({ read_only: true });
    });

    it('fails with download_failed and leaves no file when a downloaded byte is corrupted', async () => {
      s.publishFile(dbFile(50000));
      s.config.corruptDownload = true;
      const directory = dirFor('corrupt');

      const err = await failure(inScope(s, await primitives(), () => openAnalytics(DB, { directory })));

      expect(err.code).toBe('download_failed');
      expect(await readdir(directory)).toEqual([]);
    });

    it('fails with download_failed when the stored length the server reports is wrong', async () => {
      s.publishFile(dbFile(50000));
      s.config.wrongStoredBytes = true;
      const directory = dirFor('length');

      const err = await failure(inScope(s, await primitives(), () => openAnalytics(DB, { directory })));

      expect(err.code).toBe('download_failed');
      expect(await readdir(directory)).toEqual([]);
    });

    it('rejects a file_name the server sends that could escape the work folder, writing nothing', async () => {
      s.config.fileName = '../evil.duckdb';
      const directory = dirFor('evil');

      const err = await failure(inScope(s, await primitives(), () => openAnalytics(DB, { directory })));

      expect(err.code).toBe('database_invalid');
      expect(existsSync(path.join(directory, '..', 'evil.duckdb'))).toBe(false);
      expect(existsSync(path.join(tmp, 'evil.duckdb'))).toBe(false);
    });

    it('fails with not_in_workflow outside a workflow run and database_invalid for a binding that is not a uuid', async () => {
      const outside = await failure(openAnalytics(DB, { directory: dirFor('none') }));
      const badBinding = await failure(open(await primitives(), {}, 'not-a-uuid'));

      expect(outside.code).toBe('not_in_workflow');
      expect(badBinding.code).toBe('database_invalid');
      expect(s.calls).toEqual([]);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses leaseWaitSeconds %s with invalid_request, before any server call',
      async (leaseWaitSeconds) => {
        const err = await failure(open(await primitives(), { leaseWaitSeconds }));

        expect(err.code).toBe('invalid_request');
        expect(s.calls).toEqual([]);
      },
    );

    it('aborts a download that decompresses to more than the database may hold, and leaves no file', async () => {
      s.config.capBytes = 100_000; // the server reports the true 5 MB, so only the cap can refuse it
      s.publishFile(dbFile(5_000_000));
      const directory = dirFor('bomb');

      const err = await failure(inScope(s, await primitives(), () => openAnalytics(DB, { directory })));

      expect(err.code).toBe('download_failed');
      expect(await readdir(directory)).toEqual([]);
    });

    it('fails with download_failed and leaves no file when the restored size is not the size the server reported', async () => {
      s.publishFile(dbFile(50_000));
      s.config.reportedBytes = 50_001;
      const directory = dirFor('short');

      const err = await failure(inScope(s, await primitives(), () => openAnalytics(DB, { directory })));

      expect(err.code).toBe('download_failed');
      expect(await readdir(directory)).toEqual([]);
    });
  });

  describe("the SDK's own error codes", () => {
    const prepareFails = async (fault: Fault): Promise<AnalyticsError> => {
      s.faults['upload_prepare'] = [fault];
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000));
      return failure(db.publish());
    };

    it('network_error: the request never reached the server', async () => {
      const err = await prepareFails('drop');

      expect(err.code).toBe('network_error');
      expect(err.status).toBeUndefined();
    });

    it.each([
      [401, {}],
      [503, { message: 'busy' }],
    ])('request_failed: an answer %s without an app error code, with the status in details', async (status, body) => {
      const err = await prepareFails({ status, body });

      expect(err.code).toBe('request_failed');
      expect(err.status).toBe(status);
      expect(err.details).toMatchObject({ status });
      expect(s.count('upload_prepare')).toBe(1);
    });

    it('invalid_response: a 200 answer that is not the expected shape', async () => {
      const err = await prepareFails({ status: 200, body: {} });

      expect(err.code).toBe('invalid_response');
    });

    it('open_failed: three answers without an app code, with the last status in details', async () => {
      const busy = { status: 502, body: {} };
      s.faults['open'] = [busy, busy, busy];

      const err = await failure(open(await primitives()));

      expect(err.code).toBe('open_failed');
      expect(err.details).toMatchObject({ status: 502 });
      expect(s.count('open')).toBe(3);
    });

    it('feature_disabled: a 503 that carries an app code is not retried, and the step records that code', async () => {
      const off = { status: 503, body: { error: 'feature_disabled', message: 'switched off' } };
      s.faults['open'] = [off, off, off];
      const run = randomUUID();

      const err = await failure(open(await primitives(run)));

      expect(err.code).toBe('feature_disabled');
      expect(err.status).toBe(503);
      expect(s.count('open')).toBe(1);
      expect(steps(run)).toHaveLength(1);
      expect(steps(run)[0]?.error).toMatchObject({ code: 'feature_disabled' });
      // A re-dispatch replays the recorded code.
      s.faults['open'] = [];
      const replayed = await replayedFailure(open(await primitives(run)));
      expect(replayed.code).toBe('feature_disabled');
    });
  });

  describe('base recorded durably (I10)', () => {
    it('records the base in the analytics.base step and sends it as expected_base on the real open', async () => {
      const run = randomUUID();

      await open(await primitives(run));

      expect(steps(run)).toEqual([{ name: 'analytics.base', output: { baseVersionId: null, baseSeq: 0 } }]);
      expect(s.calls.map((c) => c.op)).toEqual(['open', 'open']);
      expect(s.calls[0]?.body).toEqual({ read_only: false });
      expect(s.calls[1]?.body).toEqual({ read_only: false, expected_base: { version_id: null } });
    });

    it('skips the analytics.base step on a replay and reopens with the recorded base', async () => {
      const published = s.publishFile(dbFile(20000));
      const run = randomUUID();
      await open(await primitives(run));
      s.calls.length = 0;
      const recordedBefore = steps(run);

      await open(await primitives(run));

      expect(recordedBefore).toHaveLength(1);
      expect(steps(run)).toEqual(recordedBefore);
      expect(s.calls.map((c) => c.op)).toEqual(['open']);
      expect(s.calls[0]?.body).toEqual({ read_only: false, expected_base: { version_id: published.id } });
    });

    it('surfaces base_moved when another run published since the recorded base, writing no file and starting no timer', async () => {
      const run = randomUUID();
      await open(await primitives(run));
      s.config.ttlSeconds = 3;
      const newer = s.publishFile(dbFile(20000));
      s.calls.length = 0;
      const directory = dirFor('moved');

      const err = await failure(inScope(s, await primitives(run), () => openAnalytics(DB, { directory })));
      await new Promise((r) => setTimeout(r, 1300));

      expect(err.code).toBe('base_moved');
      expect(err.message).toBe(
        'Another run published a newer version after this run started. Run the workflow again so it starts from the newest version.',
      );
      expect(err.details).toMatchObject({ latestVersionId: newer.id });
      expect(existsSync(directory) ? await readdir(directory) : []).toEqual([]);
      expect(s.count('renew')).toBe(0);
    });

    it('retries a 503 on the base open and records the base id', async () => {
      s.faults['open'] = [{ status: 503, body: { message: 'busy' } }];
      const run = randomUUID();

      const db = await open(await primitives(run));

      expect(db.version).toBe(0);
      expect(steps(run)[0]?.output).toEqual({ baseVersionId: null, baseSeq: 0 });
      expect(s.count('open')).toBe(3);
    });

    it('throws open_failed from the step after three 503 answers, and the step records the failure', async () => {
      const busy = { status: 503, body: { message: 'busy' } };
      s.faults['open'] = [busy, busy, busy];
      const run = randomUUID();

      const err = await failure(open(await primitives(run)));

      expect(err.code).toBe('open_failed');
      expect(s.count('open')).toBe(3);
      expect(steps(run)).toHaveLength(1);
      expect(steps(run)[0]?.error).toMatchObject({ code: 'open_failed' });
      // A re-dispatch replays the recorded failure without calling the server again.
      s.calls.length = 0;
      const replayed = await replayedFailure(open(await primitives(run)));
      expect(replayed.code).toBe('open_failed');
      expect(s.calls).toEqual([]);
    });
  });

  describe('lease', () => {
    const held = (retry: number): Fault => ({
      status: 409,
      body: { error: 'lease_held', message: 'held', retry_after_seconds: retry },
    });

    it('throws lease_held with retryAfterSeconds when leaseWaitSeconds is 0', async () => {
      s.faults['open'] = [held(7)];

      const err = await failure(open(await primitives()));

      expect(err.code).toBe('lease_held');
      expect(err.status).toBe(409);
      expect(err.details).toMatchObject({ retryAfterSeconds: 7 });
    });

    it('waits for a held lease up to leaseWaitSeconds and then opens', async () => {
      s.faults['open'] = [held(1)];

      const db = await open(await primitives(), { leaseWaitSeconds: 3 });

      expect(db.version).toBe(0);
      expect(s.count('open')).toBe(3);
    }, 15000);

    it('renews the lease on a timer of a third of the ttl', async () => {
      s.config.ttlSeconds = 3;
      const started = Date.now();

      await open(await primitives());
      await waitFor(() => s.count('renew') >= 1, 2500);

      expect(Date.now() - started).toBeLessThan(2500);
    });

    it('makes save and publish throw lease_lost, with no upload, after a renew answers lease_lost', async () => {
      s.config.ttlSeconds = 3;
      s.faults['renew'] = [{ status: 409, body: { error: 'lease_lost', message: 'lost' } }];
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000));
      await waitFor(() => s.count('renew') >= 1, 2500);

      let lost: AnalyticsError | undefined;
      for (let i = 0; i < 40 && !lost; i++) {
        try {
          await db.save();
          await new Promise((r) => setTimeout(r, 50));
        } catch (error) {
          lost = error as AnalyticsError;
        }
      }
      const prepares = s.count('upload_prepare');
      const publishErr = await failure(db.publish());

      expect(lost?.code).toBe('lease_lost');
      expect(publishErr.code).toBe('lease_lost');
      expect(s.count('upload_prepare')).toBe(prepares);
    }, 15000);
  });

  describe('lease timer', () => {
    it.each([401, 403, 404])(
      'stops renewing for good after a renew is answered %s with no app code, and refuses writes from then on',
      async (status) => {
        s.config.ttlSeconds = 3;
        s.faults['renew'] = [{ status, body: {} }];
        const db = await open(await primitives());
        await writeFile(db.path, dbFile(20000));
        await waitFor(() => s.count('renew') >= 1, 2500);

        await new Promise((r) => setTimeout(r, 2100)); // more than 2 x ttl/3
        const prepares = s.count('upload_prepare');
        const err = await failure(db.save());

        expect(s.count('renew')).toBe(1);
        expect(err.code).toBe('lease_lost');
        expect(err.details).toMatchObject({ renewStatus: status });
        expect(s.count('upload_prepare')).toBe(prepares);
      },
      15000,
    );

    it('keeps renewing through a dropped connection and a 5xx without an app code', async () => {
      s.config.ttlSeconds = 3;
      s.faults['renew'] = ['drop', { status: 503, body: {} }];
      const db = await open(await primitives());

      await waitFor(() => s.count('renew') >= 3, 6000);
      await writeFile(db.path, dbFile(20000));
      await db.save();

      expect(s.count('commit')).toBe(1);
    }, 15000);

    it('leaves no running timer behind when publish fails', async () => {
      s.config.ttlSeconds = 3;
      s.putFaults = ['500', '500', '500'];
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000));

      const err = await failure(db.publish());
      const renewsAfterFailure = s.count('renew');
      await new Promise((r) => setTimeout(r, 2100));

      expect(err.code).toBe('upload_failed');
      expect(s.count('renew')).toBe(renewsAfterFailure);
    }, 15000);

    it('releases the lease once when the upload fails, since the failed publish step cannot be retried', async () => {
      s.putFaults = ['500', '500', '500'];
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000));

      const err = await failure(db.publish());

      expect(err.code).toBe('upload_failed');
      expect(s.count('release')).toBe(1);
    }, 15000);

    it('releases the lease once when the commit answers base_moved', async () => {
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000));
      s.faults['commit'] = [{ status: 409, body: { error: 'base_moved', message: 'moved', latest_version_id: null } }];

      const err = await failure(db.publish());

      expect(err.code).toBe('base_moved');
      expect(s.count('release')).toBe(1);
    });
  });

  describe('publish refusals send no upload_prepare', () => {
    it.each([
      [
        'a non-empty write-ahead log',
        'wal_not_empty',
        async (path: string) => {
          await writeFile(path, dbFile(20000));
          await writeFile(`${path}.wal`, 'pending');
        },
      ],
      [
        'a storage format version above the server maximum',
        'storage_format_unsupported',
        (path: string) => writeFile(path, dbFile(20000, 67)),
      ],
      ['a file above the size cap', 'over_cap', (path: string) => writeFile(path, dbFile(20000))],
      ['a file without the DUCK magic', 'database_invalid', (path: string) => writeFile(path, Buffer.alloc(20000))],
    ])('refuses %s with %s', async (_scenario, code, prepareFile) => {
      if (code === 'over_cap') s.config.capBytes = 1000;
      const db = await open(await primitives());
      await prepareFile(db.path);

      const err = await failure(db.publish());

      expect(err.code).toBe(code);
      if (code === 'wal_not_empty') {
        expect(err.message).toContain('close your DuckDB connection or run CHECKPOINT before publish');
      }
      if (code === 'storage_format_unsupported') expect(err.message).toContain('v1.2.0');
      if (code === 'over_cap') expect(err.details).toMatchObject({ capBytes: 1000 });
      expect(s.count('upload_prepare')).toBe(0);
    });

    it('refuses publish on a read-only handle with read_only', async () => {
      s.publishFile(dbFile(20000));
      const db = await open(await primitives(), { readOnly: true });

      const err = await failure(db.publish());

      expect(err.code).toBe('read_only');
      expect(s.count('upload_prepare')).toBe(0);
    });

    const itOnLinux = process.platform === 'linux' && existsSync('/dev/full') ? it : it.skip;
    itOnLinux('maps a full disk while compressing to disk_full and sends no upload_prepare', async () => {
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000));
      await symlink('/dev/full', `${db.path}.zst.tmp`);

      const err = await failure(db.publish());

      expect(err.code).toBe('disk_full');
      expect(s.count('upload_prepare')).toBe(0);
    });
  });

  describe('publish', () => {
    it('uploads the zstd file once, commits once, returns the seq, cleans up and stops the lease timer', async () => {
      s.config.ttlSeconds = 3;
      const db = await open(await primitives());
      const contents = dbFile(30000);
      await writeFile(db.path, contents);

      const result = await db.publish();

      const prepare = s.calls.find((c) => c.op === 'upload_prepare')?.body;
      const uploadId = [...s.uploads.keys()][0] ?? '';
      const stored = s.objects.get(uploadId) ?? Buffer.alloc(0);
      expect(s.count('upload_prepare')).toBe(1);
      expect(prepare).toEqual({
        purpose: 'publish',
        bytes: 30000,
        stored_bytes: stored.length,
        sha256: sha(stored),
        storage_version_number: 64,
      });
      expect(unzstdSync(stored)).toEqual(contents);
      expect(s.puts).toEqual([{ key: uploadId, length: stored.length, status: 200 }]);
      expect(s.count('commit')).toBe(1);
      expect(result).toEqual({ version: 1, id: uploadId, bytes: 30000, storedBytes: stored.length });
      expect((await readdir(path.dirname(db.path))).sort()).toEqual([FILE_NAME]);
      expect(s.count('release')).toBe(1);
      const renewsBefore = s.count('renew');
      await new Promise((r) => setTimeout(r, 1400));
      expect(s.count('renew')).toBe(renewsBefore);
    });

    it('goes on to commit when the PUT is answered 412 on its retry, because the first attempt landed', async () => {
      s.putFaults = ['store-then-drop'];
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000));

      const result = await db.publish();

      expect(s.puts.map((p) => p.status)).toEqual([0, 412]);
      expect(s.count('commit')).toBe(1);
      expect(result.version).toBe(1);
    });

    it('retries a commit whose first response was dropped and uses the second answer', async () => {
      s.faults['commit'] = ['drop-after'];
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000));

      const result = await db.publish();

      expect(s.count('commit')).toBe(2);
      expect(s.published).toHaveLength(1);
      expect(result.version).toBe(1);
    });

    it('throws upload_failed after three 500 answers to the PUT, with no commit and no temp file', async () => {
      s.putFaults = ['500', '500', '500'];
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000));

      const err = await failure(db.publish());

      expect(err.code).toBe('upload_failed');
      expect(err.details).toMatchObject({ status: 500 });
      expect(s.count('commit')).toBe(0);
      expect((await readdir(path.dirname(db.path))).sort()).toEqual([FILE_NAME]);
    }, 15000);

    it('keeps the status of a PUT answered 403 while the connection drops: upload_failed after one attempt', async () => {
      s.putFaults = ['403-early'];
      const db = await open(await primitives());
      await writeFile(db.path, Buffer.concat([dbFile(20).subarray(0, 20), randomBytes(6_000_000)]));

      const err = await failure(db.publish());

      expect(err.code).toBe('upload_failed');
      expect(err.details).toMatchObject({ status: 403 });
      expect(s.puts).toHaveLength(1);
      expect(s.count('commit')).toBe(0);
    });

    it('does not publish twice on a replay: the recorded analytics.publish result is returned', async () => {
      const run = randomUUID();
      const db = await open(await primitives(run));
      await writeFile(db.path, dbFile(20000));
      const first = await db.publish();
      s.calls.length = 0;

      const again = await open(await primitives(run));
      const second = await again.publish();

      expect(second).toEqual(first);
      expect(s.count('upload_prepare')).toBe(0);
      expect(s.count('commit')).toBe(0);
      expect(s.count('release')).toBe(1);
    });
  });

  describe('step and save', () => {
    it('runs fn once and makes exactly one save upload; a replay skips fn and uploads nothing', async () => {
      const run = randomUUID();
      const db = await open(await primitives(run));
      let runs = 0;
      const out = await db.step('load', async () => {
        runs++;
        await writeFile(db.path, dbFile(15000));
        return 'loaded';
      });

      expect(out).toBe('loaded');
      expect(runs).toBe(1);
      expect(s.calls.filter((c) => c.op === 'upload_prepare').map((c) => c.body['purpose'])).toEqual(['save']);
      expect(s.count('commit')).toBe(1);
      expect(steps(run).map((x) => x.name)).toEqual(['analytics.base', 'load']);

      s.calls.length = 0;
      const resumed = await open(await primitives(run));
      const replayed = await resumed.step('load', () => {
        runs++;
        return 'again';
      });

      expect(replayed).toBe('loaded');
      expect(runs).toBe(1);
      expect(s.count('upload_prepare')).toBe(0);
      expect(await readFile(resumed.path)).toEqual(dbFile(15000));
    });

    it('uploads nothing when fn throws, and the error is the original one', async () => {
      const db = await open(await primitives());

      await expect(
        db.step('boom', () => {
          throw new Error('fn failed');
        }),
      ).rejects.toThrow('fn failed');

      expect(s.count('upload_prepare')).toBe(0);
    });

    it('records a wal_not_empty failure inside a step without uploading', async () => {
      const run = randomUUID();
      const db = await open(await primitives(run));

      const err = await failure(
        db.step('dirty', async () => {
          await writeFile(db.path, dbFile(20000));
          await writeFile(`${db.path}.wal`, 'pending');
        }),
      );

      expect(err.code).toBe('wal_not_empty');
      expect(s.count('upload_prepare')).toBe(0);
      expect(steps(run)[1]?.error).toMatchObject({ code: 'wal_not_empty' });
      const replayed = await replayedFailure(
        (await open(await primitives(run))).step('dirty', () => 'would run again'),
      );
      expect(replayed.code).toBe('wal_not_empty');
      expect(replayed).not.toBeInstanceOf(AnalyticsError);
    });

    it('runs a read-only step without any upload', async () => {
      s.publishFile(dbFile(20000));
      const run = randomUUID();
      const db = await open(await primitives(run), { readOnly: true });
      let runs = 0;

      const out = await db.step('look', () => {
        runs++;
        return 42;
      });

      expect(out).toBe(42);
      expect(runs).toBe(1);
      expect(steps(run).map((x) => x.name)).toEqual(['look']);
      expect(s.count('upload_prepare')).toBe(0);
    });

    it('save() makes a save-point upload that is not recorded as a step', async () => {
      const run = randomUUID();
      const db = await open(await primitives(run));
      await writeFile(db.path, dbFile(16000));

      await db.save();

      expect(s.calls.find((c) => c.op === 'upload_prepare')?.body['purpose']).toBe('save');
      expect(s.count('commit')).toBe(1);
      expect(steps(run).map((x) => x.name)).toEqual(['analytics.base']);
    });
  });

  describe('what a failure may say', () => {
    it('carries no signed URL, bearer, key or supplier name in any thrown error', async () => {
      const errors: AnalyticsError[] = [];
      const collect = async (p: Promise<unknown>) => errors.push(await failure(p));

      await collect(openAnalytics(DB));
      await collect(open(await primitives(), {}, 'not-a-uuid'));
      s.publishFile(dbFile(20000));
      s.config.corruptDownload = true;
      await collect(open(await primitives()));
      s.config.corruptDownload = false;
      s.faults['open'] = [{ status: 409, body: { error: 'lease_held', message: 'held', retry_after_seconds: 5 } }];
      await collect(open(await primitives()));
      const busy = { status: 503, body: { message: 'busy' } };
      s.faults['open'] = [busy, busy, busy];
      await collect(open(await primitives()));
      const readOnly = await open(await primitives(), { readOnly: true });
      await collect(readOnly.publish());
      const db = await open(await primitives());
      await writeFile(db.path, dbFile(20000, 67));
      await collect(db.publish());
      await writeFile(db.path, Buffer.alloc(20000));
      await collect(db.publish());
      await writeFile(db.path, dbFile(20000));
      await writeFile(`${db.path}.wal`, 'pending');
      await collect(db.publish());
      await rm(`${db.path}.wal`);
      s.config.capBytes = 30_000; // above the 20000-byte file the open restores, below what is written next
      const capped = await open(await primitives());
      await writeFile(capped.path, dbFile(40_000));
      await collect(capped.publish());
      s.config.capBytes = 10_000_000;
      s.putFaults = ['500', '500', '500'];
      const uploader = await open(await primitives());
      await writeFile(uploader.path, dbFile(20000));
      await collect(uploader.publish());
      const stale = randomUUID();
      await open(await primitives(stale));
      s.publishFile(dbFile(20000));
      await collect(open(await primitives(stale)));

      expect(errors.map((e) => e.code)).toEqual([
        'not_in_workflow',
        'database_invalid',
        'download_failed',
        'lease_held',
        'open_failed',
        'read_only',
        'storage_format_unsupported',
        'database_invalid',
        'wal_not_empty',
        'over_cap',
        'upload_failed',
        'base_moved',
      ]);
      const forbidden =
        /X-Amz|Bearer|sig-abc123|http:\/\/|127\.0\.0\.1|analytical-bearer|\b(R2|S3)\b|Cloudflare|Daytona|Blaxel|Turso|MotherDuck/i;
      for (const err of errors) {
        expect(`${err.code}: ${err.message}`).not.toMatch(forbidden);
        expect(JSON.stringify(err)).not.toMatch(forbidden);
        expect(JSON.stringify(err.details ?? null)).not.toMatch(forbidden);
      }
    }, 30000);

    it('names no supplier in the docs section or the changelog entry', async () => {
      const docs = await readFile(path.join(__dirname, '../../docs/sdk-reference.md'), 'utf8');
      const start = docs.indexOf('openAnalytics');
      const section = docs.slice(docs.lastIndexOf('\n### ', start), docs.indexOf('\n---', start));
      const changelog = await readFile(path.join(__dirname, '../../CHANGELOG.md'), 'utf8');
      const entry = changelog.slice(changelog.indexOf('## 0.11.0'), changelog.indexOf('## 0.10.0'));

      expect(section).toContain('CHECKPOINT');
      for (const code of [
        'not_in_workflow',
        'database_invalid',
        'invalid_request',
        'wal_not_empty',
        'upload_failed',
        'download_failed',
        'disk_full',
        'read_only',
        'network_error',
        'request_failed',
        'invalid_response',
        'open_failed',
        'zstd_unsupported',
      ]) {
        expect(section).toContain(`\`${code}\``);
      }
      expect(section).not.toContain('server_error');
      expect(entry).toContain('MINOR: Add `openAnalytics`');
      expect(entry).toContain('needs a server that has DuckDB databases switched on');
      for (const text of [section, entry]) {
        expect(text).not.toMatch(/\b(R2|S3)\b|Cloudflare|Daytona|Blaxel|Turso|MotherDuck/i);
      }
    });
  });
});
