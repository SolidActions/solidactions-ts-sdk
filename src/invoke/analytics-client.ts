import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open as openFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import * as zlib from 'node:zlib';

import { getCurrentScope } from './runtime-scope';
import type { DurablePrimitives } from './types';

export interface AnalyticsPublishResult {
  /** The seq the server assigned to the published version. */
  version: number;
  id: string;
  /** Size of the database file, in bytes. */
  bytes: number;
  /** Size of the compressed copy that was stored, in bytes. */
  storedBytes: number;
}

export interface AnalyticsDatabase {
  /** Absolute path of `<name>.duckdb` in the work folder. */
  readonly path: string;
  /** Seq of the published base; 0 when the database is new (empty template). */
  readonly version: number;
  readonly readOnly: boolean;
  /**
   * Durable step. Runs `fn`, then uploads a save point of the file when `fn` succeeds. The file must be quiescent
   * (connection closed, or `CHECKPOINT` run) when `fn` ends. On a replay `fn` is skipped.
   */
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  /** Explicit save point (not durable by itself). */
  save(): Promise<void>;
  /** Publishes the file as the next version. Throws on a read-only handle. */
  publish(): Promise<AnalyticsPublishResult>;
}

export interface OpenAnalyticsOptions {
  readOnly?: boolean;
  /** Work folder. Default: `<os.tmpdir()>/solidactions-analytics/<databaseId>`. */
  directory?: string;
  /** How long to wait for another run's write lease. Default 0 (throw `lease_held` at once). */
  leaseWaitSeconds?: number;
}

export class AnalyticsError extends Error {
  code: string;
  status?: number;
  details?: unknown;

  constructor(code: string, message: string, extra: { status?: number; details?: unknown } = {}) {
    super(message);
    this.name = 'AnalyticsError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.details !== undefined) this.details = extra.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type Json = Record<string, unknown>;

interface Session {
  apiUrl: string;
  apiKey: string;
  databaseId: string;
  primitives: DurablePrimitives;
}
interface Limits {
  capBytes: number;
  maxStorageVersion: number;
  storagePin: string;
}
interface BaseRecord {
  baseVersionId: string | null;
  baseSeq: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^[a-z][a-z0-9_-]{0,62}\.duckdb$/;
const REQUEST_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 900_000;
const ATTEMPTS = 3;
const BACKOFF_MS = [250, 500];
const BASE_MOVED_MESSAGE =
  'Another run published a newer version after this run started. Run the workflow again so it starts from the newest version.';

function invalidResponse(): AnalyticsError {
  return new AnalyticsError('invalid_response', 'The server sent an answer this SDK does not understand.');
}
function record(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Json;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw invalidResponse();
  return value;
}
function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidResponse();
  return value;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Compress/decompress with zstd from `node:zlib` (Node 24+; `@types/node` 20 has no typings for it). */
function zstd(kind: 'compress' | 'decompress'): Transform {
  const z = zlib as unknown as { createZstdCompress?: () => Transform; createZstdDecompress?: () => Transform };
  const make = kind === 'compress' ? z.createZstdCompress : z.createZstdDecompress;
  if (typeof make !== 'function') {
    throw new AnalyticsError(
      'zstd_unsupported',
      'This Node.js version cannot read or write zstd files. Use Node.js 24 or newer.',
    );
  }
  return make.call(zlib);
}

function errorFromResponse(status: number, raw: string): AnalyticsError {
  let body: Json = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Json;
  } catch {
    // not JSON: fall through to the generic code
  }
  const code = typeof body['error'] === 'string' ? body['error'] : 'request_failed';
  const message =
    code === 'base_moved'
      ? BASE_MOVED_MESSAGE
      : typeof body['message'] === 'string' && body['message'] !== ''
        ? body['message']
        : `The request failed (${status}).`;
  const details: Json = code === 'request_failed' ? { status } : {};
  for (const [key, value] of Object.entries(body))
    if (key !== 'error' && key !== 'message') details[camel(key)] = value;
  return new AnalyticsError(code, message, {
    status,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });
}

async function call(session: Session, operation: string, body: Json): Promise<Json> {
  const url = `${session.apiUrl}/duckdb-databases/${encodeURIComponent(session.databaseId)}/${operation}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AnalyticsError('network_error', 'The request to the server failed before it answered.');
  }
  const raw = await response.text().catch(() => '');
  if (!response.ok) throw errorFromResponse(response.status, raw);
  try {
    return record(JSON.parse(raw));
  } catch {
    throw invalidResponse();
  }
}

/**
 * Worth trying again: the request never arrived, or the server failed without naming an app code. A 5xx that carries
 * an app code (`feature_disabled`) is the server's answer, not a hiccup.
 */
function transient(error: unknown): boolean {
  return (
    error instanceof AnalyticsError &&
    (error.code === 'network_error' ||
      (error.code === 'request_failed' && error.status !== undefined && error.status >= 500))
  );
}

async function retrying<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (i >= ATTEMPTS || !transient(error)) throw error;
      await sleep(BACKOFF_MS[i - 1] ?? 500);
    }
  }
}

/** `open`, retried on network errors and 5xx; waits out a held lease for up to `waitSeconds`. */
async function openCall(session: Session, body: Json, waitSeconds: number): Promise<Json> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    try {
      return await retrying(() => call(session, 'open', body));
    } catch (error) {
      if (transient(error)) {
        throw new AnalyticsError(
          'open_failed',
          'Could not open the database: the server did not answer successfully.',
          {
            ...((error as AnalyticsError).status !== undefined
              ? { status: (error as AnalyticsError).status, details: { status: (error as AnalyticsError).status } }
              : {}),
          },
        );
      }
      const remaining = deadline - Date.now();
      if (!(error instanceof AnalyticsError) || error.code !== 'lease_held' || remaining <= 0) throw error;
      const hint = (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      const seconds = Math.min(typeof hint === 'number' && hint > 0 ? hint : 1, 30);
      await sleep(Math.min(seconds * 1000, remaining));
    }
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
function enospc(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC';
}

/** Passes bytes through while hashing and counting them. */
function tally(hash: ReturnType<typeof createHash> | undefined, counter: { bytes: number }): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash?.update(chunk);
      counter.bytes += chunk.length;
      done(null, chunk);
    },
  });
}

/** Fails the stream as soon as more than `max` bytes have passed. */
function ceiling(counter: { bytes: number }, max: number): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      counter.bytes += chunk.length;
      done(counter.bytes > max ? new Error('The file is larger than the database may be.') : null, chunk);
    },
  });
}

async function restore(file: string, base: Json, limits: Limits): Promise<void> {
  const partial = `${file}.partial`;
  const failed = () => new AnalyticsError('download_failed', 'Could not restore the database file from the server.');
  try {
    if (base['kind'] === 'empty') {
      const template = Buffer.from(text(base['template_base64']), 'base64');
      if (sha256(template) !== text(base['template_sha256'])) throw failed();
      await writeFile(partial, template, { mode: 0o600 });
    } else {
      const version = record(base['version']);
      const response = await fetch(text(base['url']), { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
      if (!response.ok || !response.body) throw failed();
      const hash = createHash('sha256');
      const stored = { bytes: 0 };
      const restored = { bytes: 0 };
      const expectedBytes = num(version['bytes']);
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        tally(hash, stored),
        zstd('decompress'),
        ceiling(restored, Math.min(limits.capBytes, expectedBytes)),
        createWriteStream(partial, { mode: 0o600 }),
      );
      if (
        stored.bytes !== num(version['stored_bytes']) ||
        hash.digest('hex') !== text(version['sha256']) ||
        restored.bytes !== expectedBytes
      ) {
        throw failed();
      }
    }
    await rm(`${file}.wal`, { force: true });
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof AnalyticsError) throw error;
    if (enospc(error))
      throw new AnalyticsError('disk_full', 'There is no space left on the disk for the database file.');
    throw failed();
  }
}

/** One PUT attempt. Resolves the HTTP status, or 'network' when the connection failed. */
function putOnce(url: URL, headers: Record<string, string>, file: string): Promise<number | 'network'> {
  return new Promise((resolve) => {
    const make = url.protocol === 'https:' ? httpsRequest : httpRequest;
    // A refusal (non-2xx) whose headers have arrived keeps its status even when the connection dies before its body
    // or the request body is done: the server answered, so this is not a network failure. A 2xx must be complete.
    let answered: number | undefined;
    const outcome = (complete: boolean): number | 'network' =>
      answered !== undefined && (complete || answered >= 300) ? answered : 'network';
    const req = make(url, { method: 'PUT', headers }, (res) => {
      answered = res.statusCode;
      res.resume();
      res.on('close', () => resolve(outcome(res.complete)));
    });
    req.setTimeout(TRANSFER_TIMEOUT_MS, () => req.destroy());
    req.on('error', () => resolve(outcome(false)));
    pipeline(createReadStream(file), req).catch(() => resolve(outcome(false)));
  });
}

async function putObject(prepared: Json, file: string, storedBytes: number): Promise<void> {
  const failed = (status?: number) =>
    new AnalyticsError('upload_failed', 'Could not upload the database file.', {
      ...(status !== undefined ? { details: { status } } : {}),
    });
  let url: URL;
  try {
    url = new URL(text(prepared['url']));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw failed();
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(record(prepared['headers'] ?? {}))) {
    const lower = name.toLowerCase();
    if (lower !== 'content-length' && lower !== 'transfer-encoding' && typeof value === 'string') headers[name] = value;
  }
  headers['Content-Length'] = String(storedBytes);
  let last: number | 'network' = 'network';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await putOnce(url, headers, file);
    if (typeof last === 'number' && last >= 200 && last < 300) return;
    // A 412 or 409 on a retry means the first attempt landed even though its answer was lost.
    if (attempt > 1 && (last === 412 || last === 409)) return;
    const retry = last === 'network' || last >= 500;
    if (!retry) throw failed(last === 'network' ? undefined : last);
    if (attempt < ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] ?? 500);
  }
  throw failed(typeof last === 'number' ? last : undefined);
}

async function readHeader(file: string): Promise<Buffer> {
  const bad = () => new AnalyticsError('database_invalid', 'The file is not a DuckDB database file.');
  let handle;
  try {
    handle = await openFile(file, 'r');
  } catch {
    throw new AnalyticsError('database_invalid', 'The database file is missing from the work folder.');
  }
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    if (bytesRead < 20 || header.toString('latin1', 8, 12) !== 'DUCK') throw bad();
    return header;
  } finally {
    await handle.close();
  }
}

/**
 * Opens a DuckDB database that lives on the server: restores its newest file into a work folder and, unless
 * `readOnly`, holds the write lease (renewed in the background) until `publish()`.
 */
export async function openAnalytics(binding: string, options: OpenAnalyticsOptions = {}): Promise<AnalyticsDatabase> {
  const scope = getCurrentScope();
  const params = scope?.runtimeParams;
  const primitives = scope?.primitives;
  if (!params?.apiUrl || !params.apiKey || !primitives) {
    throw new AnalyticsError('not_in_workflow', 'openAnalytics can only be used inside a running workflow.');
  }
  if (typeof binding !== 'string' || !UUID.test(binding)) {
    throw new AnalyticsError('database_invalid', 'The database binding must be the database id (a uuid).');
  }
  const waitSeconds = options.leaseWaitSeconds ?? 0;
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new AnalyticsError('invalid_request', 'leaseWaitSeconds must be a number of seconds, 0 or more.');
  }
  const readOnly = options.readOnly === true;
  const session: Session = {
    apiUrl: params.apiUrl.replace(/\/+$/, ''),
    apiKey: params.apiKey,
    databaseId: binding.toLowerCase(),
    primitives,
  };

  let recorded: BaseRecord | undefined;
  if (!readOnly) {
    // Recorded once per run: a re-dispatched run reopens with the base it started from (I10).
    recorded = await primitives.step(
      async (): Promise<BaseRecord> => {
        const reply = await openCall(session, { read_only: false }, waitSeconds);
        const base = record(reply['base']);
        const seq =
          base['kind'] === 'published' ? num(record(base['version'])['seq']) : base['kind'] === 'empty' ? 0 : null;
        const lease = record(reply['lease']);
        return {
          baseVersionId: lease['base_version_id'] === null ? null : text(lease['base_version_id']),
          baseSeq: seq,
        };
      },
      { name: 'analytics.base' },
    );
  }

  const reply = await openCall(
    session,
    readOnly
      ? { read_only: true }
      : { read_only: false, expected_base: { version_id: recorded?.baseVersionId ?? null } },
    waitSeconds,
  );
  const fileName = text(record(reply['database'])['file_name']);
  if (!FILE_NAME.test(fileName)) {
    throw new AnalyticsError(
      'database_invalid',
      'The server named the database file in a way this SDK refuses to use.',
    );
  }
  const limitsRaw = record(reply['limits']);
  const limits: Limits = {
    capBytes: num(limitsRaw['cap_bytes']),
    maxStorageVersion: num(limitsRaw['max_storage_version_number']),
    storagePin: text(limitsRaw['storage_version_pin']),
  };
  const base = record(reply['base']);
  const lease = readOnly ? undefined : record(reply['lease']);

  const directory = path.resolve(
    options.directory ?? path.join(os.tmpdir(), 'solidactions-analytics', session.databaseId),
  );
  const file = path.join(directory, fileName);
  const releaseQuietly = () => call(session, 'release', {}).catch(() => undefined);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await restore(file, base, limits);
  } catch (error) {
    if (!readOnly) await releaseQuietly();
    throw error;
  }
  const version =
    base['kind'] === 'published'
      ? num(record(base['version'])['seq'])
      : base['kind'] === 'empty'
        ? 0
        : (recorded?.baseSeq ?? 0);

  let leaseLost: { status?: number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  if (lease) {
    let renewing = false;
    timer = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        call(session, 'renew', {})
          .catch((error: unknown) => {
            // Only a dropped connection or a 5xx without an app code is worth another try on the next tick.
            // Anything else (lease_lost, 401, 403, any 4xx) means this run cannot keep the lease.
            if (error instanceof AnalyticsError && !transient(error)) {
              leaseLost = error.status !== undefined ? { status: error.status } : {};
              stopTimer();
            }
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(1000, (num(lease['ttl_seconds']) * 1000) / 3),
    );
    timer.unref();
  }

  const assertLease = () => {
    if (leaseLost) {
      throw new AnalyticsError('lease_lost', 'This run no longer holds the write lease for the database.', {
        status: 409,
        ...(leaseLost.status !== undefined ? { details: { renewStatus: leaseLost.status } } : {}),
      });
    }
  };

  async function upload(purpose: 'save' | 'publish'): Promise<AnalyticsPublishResult | undefined> {
    assertLease();
    const walSize = await stat(`${file}.wal`).then(
      (s) => s.size,
      () => 0,
    );
    if (walSize > 0) {
      throw new AnalyticsError(
        'wal_not_empty',
        'The database still has pending changes in its write-ahead log: close your DuckDB connection or run CHECKPOINT before publish.',
      );
    }
    const header = await readHeader(file);
    const storageVersion = header.readBigUInt64LE(12);
    if (storageVersion > BigInt(limits.maxStorageVersion)) {
      throw new AnalyticsError(
        'storage_format_unsupported',
        `This database file uses storage format ${storageVersion}, newer than the ${limits.maxStorageVersion} this server supports. Write it with DuckDB ${limits.storagePin}.`,
        { details: { max: limits.maxStorageVersion, storageVersionPin: limits.storagePin } },
      );
    }
    const size = (await stat(file)).size;
    if (size > limits.capBytes) {
      throw new AnalyticsError(
        'over_cap',
        `The database is ${size} bytes, over its limit of ${limits.capBytes} bytes.`,
        {
          details: { capBytes: limits.capBytes, bytes: size },
        },
      );
    }

    const temp = `${file}.zst.tmp`;
    try {
      const hash = createHash('sha256');
      const raw = { bytes: 0 };
      const stored = { bytes: 0 };
      try {
        await pipeline(
          createReadStream(file),
          tally(undefined, raw),
          zstd('compress'),
          tally(hash, stored),
          createWriteStream(temp, { mode: 0o600 }),
        );
      } catch (error) {
        if (error instanceof AnalyticsError) throw error;
        if (enospc(error))
          throw new AnalyticsError('disk_full', 'There is no space left on the disk to prepare the upload.');
        throw new AnalyticsError('upload_failed', 'Could not prepare the database file for upload.');
      }
      const prepared = await call(session, 'upload_prepare', {
        purpose,
        bytes: raw.bytes,
        stored_bytes: stored.bytes,
        sha256: hash.digest('hex'),
        storage_version_number: Number(storageVersion),
      });
      const uploadId = text(prepared['upload_id']);
      await putObject(prepared, temp, stored.bytes);
      const committed = record(
        record(await retrying(() => call(session, 'commit', { upload_id: uploadId })))['version'],
      );
      if (purpose === 'save') return undefined;
      return {
        version: num(committed['seq']),
        id: text(committed['id']),
        bytes: num(committed['bytes']),
        storedBytes: num(committed['stored_bytes']),
      };
    } finally {
      await rm(temp, { force: true });
    }
  }

  return {
    path: file,
    version,
    readOnly,
    step: <T>(name: string, fn: () => T | Promise<T>): Promise<T> =>
      readOnly
        ? primitives.step(fn, { name })
        : primitives.step(
            async () => {
              assertLease();
              const out = await fn();
              await upload('save');
              return out;
            },
            { name },
          ),
    save: async () => {
      if (readOnly) throw new AnalyticsError('read_only', 'This database was opened read-only, so it cannot be saved.');
      await upload('save');
    },
    publish: async () => {
      if (readOnly)
        throw new AnalyticsError('read_only', 'This database was opened read-only, so it cannot be published.');
      let result: AnalyticsPublishResult;
      try {
        result = await primitives.step(
          async () => {
            const published = await upload('publish');
            if (!published) throw invalidResponse();
            return published;
          },
          { name: 'analytics.publish' },
        );
      } catch (error) {
        // The failed step is recorded permanently, so this run cannot retry it: free the lease for the next run.
        stopTimer();
        await releaseQuietly();
        throw error;
      }
      stopTimer();
      // On a replay the recorded publish is skipped but this run holds a fresh lease: give it back.
      await releaseQuietly();
      return result;
    },
  };
}
