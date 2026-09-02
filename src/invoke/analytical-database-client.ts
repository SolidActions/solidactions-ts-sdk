import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';

import { getCurrentScope } from './runtime-scope';
import type { AnalyticalDatabaseBinding, DatabaseVar } from './types';

export type AnalyticalIngestMode = 'append' | 'replace';
export type AnalyticalFileFormat = 'parquet' | 'csv' | 'jsonl';
export interface AnalyticalIngestOptions {
  batchId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface AnalyticalFileIngestOptions extends AnalyticalIngestOptions {
  mode?: AnalyticalIngestMode;
  format?: AnalyticalFileFormat;
}
export interface AnalyticalIngestResult {
  batchId: string;
  state: 'acked';
  rows: number;
  durable: true;
  liveBytes: number;
  ackedAt: string;
}
export interface AnalyticalDatabaseClient {
  append(
    table: string,
    rows: readonly Record<string, unknown>[],
    options?: AnalyticalIngestOptions,
  ): Promise<AnalyticalIngestResult>;
  replace(
    table: string,
    rows: readonly Record<string, unknown>[],
    options?: AnalyticalIngestOptions,
  ): Promise<AnalyticalIngestResult>;
  ingestFile(table: string, path: string, options?: AnalyticalFileIngestOptions): Promise<AnalyticalIngestResult>;
}

export class AnalyticalIngestError extends Error {
  readonly code: string;
  readonly batchId?: string;
  readonly lastState?: string;
  readonly status?: number;
  readonly details?: Record<string, unknown>;
  constructor(
    message: string,
    fields: { code: string; batchId?: string; lastState?: string; status?: number; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AnalyticalIngestError';
    Object.assign(this, fields);
    this.code = fields.code;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Reply = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BATCH = /^(?!sa-)[A-Za-z0-9._-]{1,128}$/;
const RETRYABLE = new Set(['waking', 'overloaded', 'too_many_batches']);
const INLINE_BATCH_MAX_BYTES = 5_242_880;

function jsonValue(value: unknown, path = '$'): Json {
  if (value instanceof Date) return value.toJSON();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
      throw new Error(
        `[createAnalyticalDatabaseClient] rows must contain valid Unicode JSON strings; lone surrogate at ${path}`,
      );
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error(`[createAnalyticalDatabaseClient] rows must contain JSON values; ${path} is non-finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      throw new Error(`[createAnalyticalDatabaseClient] rows must not contain sparse arrays at ${path}`);
    return value.map((v, i) => jsonValue(v, `${path}[${i}]`));
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (Object.getOwnPropertySymbols(value).length)
      throw new Error(`[createAnalyticalDatabaseClient] rows must not contain symbol keys at ${path}`);
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value)) {
      jsonValue(key, `${path} key`);
      out[key] = jsonValue((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return out;
  }
  throw new Error(`[createAnalyticalDatabaseClient] rows must contain JSON values; unsupported value at ${path}`);
}

/** RFC 8785 JSON Canonicalization Scheme serializer. */
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}
function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function digest(
  database: string,
  table: string,
  mode: AnalyticalIngestMode,
  format: string,
  contentSha: string,
): string {
  return sha(
    canonical({ ack: 'durable', content_sha256: contentSha, database_id: database, format, mode, table, v: 1 }),
  );
}
function batchId(explicit: string | undefined, derived: string): string {
  const id = explicit ?? derived.slice(0, 32);
  if (!BATCH.test(id))
    throw new Error(
      '[createAnalyticalDatabaseClient] batchId must match [A-Za-z0-9._-]{1,128} and must not start with reserved sa-',
    );
  return id;
}
function timeout(value: number | undefined, fallback: number): number {
  if (value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0))
    throw new Error('[createAnalyticalDatabaseClient] timeoutMs must be a positive finite integer');
  return value ?? fallback;
}
function transport(): { url: string; key: string } {
  const scope = getCurrentScope();
  const url = scope ? scope.runtimeParams.apiUrl : process.env.SOLIDACTIONS_API_URL;
  const key = scope ? scope.runtimeParams.apiKey : process.env.SOLIDACTIONS_API_KEY;
  if (!url || !key)
    throw new Error(
      '[createAnalyticalDatabaseClient] this helper is workflow-only and requires the run-scoped API URL and bearer',
    );
  return { url: url.replace(/\/+$/, ''), key };
}
function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}
function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  check(signal);
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(signal?.reason instanceof Error ? signal.reason : abortError());
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function errorFrom(body: Reply, status?: number, id?: string, state?: string): AnalyticalIngestError {
  const details = (body.details && typeof body.details === 'object' ? body.details : body) as Record<string, unknown>;
  const code = textValue(body.error_code, textValue(body.code, textValue(body.error, 'ingest_failed')));
  return new AnalyticalIngestError(textValue(body.message, `Analytical ingest failed (${code})`), {
    code,
    batchId: id,
    lastState: state,
    status,
    details,
  });
}
function unwrap(body: unknown): Reply {
  const value = body as Reply;
  for (const key of ['data', 'result']) if (value?.[key] && typeof value[key] === 'object') return value[key] as Reply;
  return value;
}
function ack(body: Reply, id: string): AnalyticalIngestResult {
  if (
    body.batch_id !== id ||
    body.state !== 'acked' ||
    typeof body.rows !== 'number' ||
    !Number.isSafeInteger(body.rows) ||
    body.rows < 0 ||
    body.durable !== true ||
    typeof body.live_bytes !== 'number' ||
    !Number.isFinite(body.live_bytes) ||
    body.live_bytes < 0 ||
    typeof body.acked_at !== 'string' ||
    body.acked_at.length === 0
  ) {
    throw new AnalyticalIngestError('Analytical ingest returned an invalid acked response', {
      code: 'invalid_ingest_response',
      batchId: id,
      lastState: 'acked',
      details: body,
    });
  }
  return {
    batchId: body.batch_id,
    state: 'acked',
    rows: body.rows,
    durable: true,
    liveBytes: body.live_bytes,
    ackedAt: body.acked_at,
  };
}

export function createAnalyticalDatabaseClient(
  database: AnalyticalDatabaseBinding | DatabaseVar,
): AnalyticalDatabaseClient {
  if (typeof database !== 'string')
    throw new Error('[createAnalyticalDatabaseClient] received a libSQL DatabaseVar; use createDatabaseClient instead');
  if (!UUID.test(database))
    throw new Error('[createAnalyticalDatabaseClient] analytical database binding must be a UUID');
  const databaseId = database.toLowerCase();

  async function operation(
    name: string,
    payload: Reply | string,
    id: string,
    signal: AbortSignal | undefined,
    deadline = Infinity,
  ): Promise<Reply> {
    for (;;) {
      check(signal);
      if (performance.now() >= deadline)
        throw new AnalyticalIngestError('Analytical ingest remains pending; retry the identical call', {
          code: 'ingest_pending',
          batchId: id,
        });
      const { url, key } = transport();
      let response: Response;
      try {
        const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
        const deadlineSignal = Number.isFinite(deadline) ? AbortSignal.timeout(remaining) : undefined;
        const requestSignal =
          signal && deadlineSignal ? AbortSignal.any([signal, deadlineSignal]) : (signal ?? deadlineSignal);
        response = await fetch(`${url}/analytical-databases/${encodeURIComponent(databaseId)}/${name}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: typeof payload === 'string' ? payload : JSON.stringify(payload),
          signal: requestSignal,
        });
      } catch (cause) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
        if (performance.now() >= deadline)
          throw new AnalyticalIngestError('Analytical ingest remains pending; retry the identical call', {
            code: 'ingest_pending',
            batchId: id,
          });
        throw new AnalyticalIngestError('Analytical ingest network request failed', {
          code: 'network_error',
          batchId: id,
          details: { cause: cause instanceof Error ? cause.name : 'Error' },
        });
      }
      let body: Reply = {};
      try {
        body = unwrap(await response.json());
      } catch {
        /* structured body is optional */
      }
      const code = textValue(body.code, textValue(body.error_code, textValue(body.state)));
      if (RETRYABLE.has(code)) {
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          throw new AnalyticalIngestError('Analytical ingest remains pending; retry the identical call', {
            code: 'ingest_pending',
            batchId: id,
            lastState: code,
          });
        await delay(Math.min(remaining, Math.max(0, Math.min(5000, Number(body.retry_after_ms ?? 250)))), signal);
        continue;
      }
      if (!response.ok) throw errorFrom(body, response.status, id);
      return body;
    }
  }

  async function wait(
    initial: Reply,
    id: string,
    deadline: number,
    signal?: AbortSignal,
    onPrepared?: () => Promise<Reply>,
  ): Promise<AnalyticalIngestResult> {
    let reply = initial;
    let interval = 250;
    let state = textValue(reply.state);
    for (;;) {
      if (state === 'acked') return ack(reply, id);
      if (state === 'failed') throw errorFrom(reply, undefined, id, state);
      if (performance.now() >= deadline)
        throw new AnalyticalIngestError('Analytical ingest remains pending; retry the identical call', {
          code: 'ingest_pending',
          batchId: id,
          lastState: state,
        });
      await delay(Math.min(deadline - performance.now(), Math.floor(Math.random() * interval)), signal);
      if (performance.now() >= deadline)
        throw new AnalyticalIngestError('Analytical ingest remains pending; retry the identical call', {
          code: 'ingest_pending',
          batchId: id,
          lastState: state,
        });
      if (state === 'prepared' && onPrepared) {
        try {
          reply = await onPrepared();
        } catch (error) {
          if (error instanceof AnalyticalIngestError && error.code === 'ingest_pending' && !error.lastState) {
            throw new AnalyticalIngestError(error.message, {
              code: error.code,
              batchId: error.batchId ?? id,
              lastState: state,
              status: error.status,
              details: error.details,
            });
          }
          throw error;
        }
        state = textValue(reply.state);
        interval = Math.min(5000, interval * 2);
        continue;
      }
      try {
        reply = await operation('ingest_status', { batch_id: id }, id, signal, deadline);
      } catch (error) {
        if (error instanceof AnalyticalIngestError && error.code === 'ingest_pending' && !error.lastState) {
          throw new AnalyticalIngestError(error.message, {
            code: error.code,
            batchId: error.batchId ?? id,
            lastState: state,
            status: error.status,
            details: error.details,
          });
        }
        throw error;
      }
      state = textValue(reply.state);
      interval = Math.min(5000, interval * 2);
    }
  }

  async function recoverLost(id: string, deadline: number, signal?: AbortSignal): Promise<Reply> {
    return operation('ingest_status', { batch_id: id }, id, signal, deadline);
  }

  async function inline(
    mode: AnalyticalIngestMode,
    rawTable: string,
    rows: readonly Record<string, unknown>[],
    options: AnalyticalIngestOptions = {},
  ) {
    const table = rawTable.trim().toLowerCase();
    const signal = options.signal;
    check(signal);
    const validated = jsonValue(rows) as Json[];
    const rowsBytes = canonical(validated);
    const contentSha = sha(rowsBytes);
    const id = batchId(options.batchId, digest(databaseId, table, mode, 'rows', contentSha));
    const deadline = performance.now() + timeout(options.timeoutMs, 120_000);
    const head = JSON.stringify({ table, mode, batch_id: id }).slice(0, -1);
    const payload = `${head},\"rows\":${rowsBytes}}`;
    if (Buffer.byteLength(payload, 'utf8') > INLINE_BATCH_MAX_BYTES) {
      throw new AnalyticalIngestError(
        'Inline analytical ingest exceeds inline_batch_max_bytes=5,242,880 bytes (5 MiB)',
        {
          code: 'inline_batch_too_large',
          batchId: id,
        },
      );
    }
    let reply: Reply;
    try {
      reply = await operation('ingest', payload, id, signal, deadline);
    } catch (error) {
      if (!(error instanceof AnalyticalIngestError) || error.code !== 'network_error') throw error;
      reply = await recoverLost(id, deadline, signal);
    }
    return wait(reply, id, deadline, signal);
  }

  async function ingestFile(rawTable: string, path: string, options: AnalyticalFileIngestOptions = {}) {
    const table = rawTable.trim().toLowerCase();
    const mode = options.mode ?? 'append';
    const signal = options.signal;
    check(signal);
    const deadline = performance.now() + timeout(options.timeoutMs, 2_700_000);
    const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
    const stageSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    const ext = path.toLowerCase().match(/\.([^.]+)$/)?.[1];
    const format = options.format ?? (ext === 'parquet' || ext === 'csv' || ext === 'jsonl' ? ext : undefined);
    if (!format)
      throw new Error(
        '[createAnalyticalDatabaseClient] format is required unless path ends in .parquet, .csv, or .jsonl',
      );
    const info = await stat(path);
    const hash = createHash('sha256');
    try {
      for await (const chunk of createReadStream(path, { signal: stageSignal })) hash.update(chunk as Buffer);
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
      if (deadlineSignal.aborted)
        throw new AnalyticalIngestError('Analytical ingest remains pending; retry the identical call', {
          code: 'ingest_pending',
        });
      throw error;
    }
    const contentSha = hash.digest('hex');
    const id = batchId(options.batchId, digest(databaseId, table, mode, format, contentSha));
    const preparePayload = { table, mode, batch_id: id, format, declared_bytes: info.size, content_sha256: contentSha };
    let prepared: Reply;
    try {
      prepared = await operation('ingest_prepare', preparePayload, id, signal, deadline);
    } catch (error) {
      if (!(error instanceof AnalyticalIngestError) || error.code !== 'network_error') throw error;
      prepared = await recoverLost(id, deadline, signal);
    }
    if (!prepared.upload_url && prepared.state === 'prepared') {
      prepared = await operation('ingest_prepare', preparePayload, id, signal, deadline);
    }
    if (!prepared.upload_url) return wait(prepared, id, deadline, signal);
    let signed: URL;
    try {
      signed = new URL(textValue(prepared.upload_url));
      if (signed.protocol !== 'http:' && signed.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      throw new AnalyticalIngestError('Staged upload failed', { code: 'upload_failed', batchId: id });
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((prepared.upload_headers ?? {}) as Record<string, unknown>)) {
      const lower = name.toLowerCase();
      if (lower !== 'content-length' && lower !== 'transfer-encoding' && typeof value === 'string')
        headers[name] = value;
    }
    headers['Content-Length'] = String(info.size);
    await new Promise<void>((resolve, reject) => {
      const req = (signed.protocol === 'https:' ? httpsRequest : httpRequest)(
        signed,
        { method: 'PUT', headers, signal: stageSignal },
        (res) => {
          res.resume();
          res.on('end', () =>
            res.statusCode && res.statusCode >= 200 && res.statusCode < 300
              ? resolve()
              : reject(
                  new AnalyticalIngestError('Staged upload failed', {
                    code: 'upload_failed',
                    batchId: id,
                    status: res.statusCode,
                  }),
                ),
          );
        },
      );
      req.on('error', (cause) => {
        if (signal?.aborted) reject(signal.reason instanceof Error ? signal.reason : abortError());
        else if (deadlineSignal.aborted)
          reject(
            new AnalyticalIngestError('Analytical ingest remains pending; retry the identical call', {
              code: 'ingest_pending',
              batchId: id,
            }),
          );
        else
          reject(
            new AnalyticalIngestError('Staged upload failed', {
              code: 'upload_failed',
              batchId: id,
              details: { cause: cause.name },
            }),
          );
      });
      void pipeline(createReadStream(path, { signal: stageSignal }), req).catch((error: unknown) => {
        if (deadlineSignal.aborted && !signal?.aborted)
          reject(
            new AnalyticalIngestError('Analytical ingest remains pending; retry the identical call', {
              code: 'ingest_pending',
              batchId: id,
            }),
          );
        else if (signal?.aborted) reject(signal.reason instanceof Error ? signal.reason : abortError());
        else
          reject(
            new AnalyticalIngestError('Staged upload failed', {
              code: 'upload_failed',
              batchId: id,
              details: { cause: error instanceof Error ? error.name : 'Error' },
            }),
          );
      });
    });
    let committed: Reply;
    try {
      committed = await operation('ingest_commit', { batch_id: id }, id, signal, deadline);
    } catch (error) {
      if (!(error instanceof AnalyticalIngestError) || error.code !== 'network_error') throw error;
      committed = await recoverLost(id, deadline, signal);
      if (committed.state === 'prepared')
        committed = await operation('ingest_commit', { batch_id: id }, id, signal, deadline);
    }
    return wait(committed, id, deadline, signal, () =>
      operation('ingest_commit', { batch_id: id }, id, signal, deadline),
    );
  }
  return {
    append: (table, rows, options) => inline('append', table, rows, options),
    replace: (table, rows, options) => inline('replace', table, rows, options),
    ingestFile,
  };
}
