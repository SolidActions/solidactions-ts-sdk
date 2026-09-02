/**
 * Issue #1127 — `createDatabaseClient`: a THIN helper wrapping a
 * `DatabaseVar` (`ctx.vars.MYDB`) in a client that executes raw SQL against
 * the workspace database via the libSQL Hrana-over-HTTP API
 * (`POST /v2/pipeline`), Bearer-authenticated with the var's token.
 *
 * Spec §7B is binding: SQL passthrough is a contract, not an accident — this
 * helper must never abstract away raw SQL (no query-builder wrapper, no
 * dialect filtering), and naming stays vendor-neutral (`createDatabaseClient`
 * / `DatabaseVar`, never Turso-named) even though the wire protocol
 * (libSQL/Hrana) is vendor-specific under the hood. No heavy client
 * dependency — just `fetch`.
 */

import type { AnalyticalDatabaseBinding, DatabaseVar } from './types';

/**
 * A single decoded Hrana value, as returned in a row. Integer cells beyond
 * `Number.MAX_SAFE_INTEGER` are returned as their original decimal STRING
 * (never silently rounded) — the same precision-preserving rationale as
 * {@link DatabaseExecuteResult.lastInsertRowid}.
 */
export type DatabaseValue = string | number | boolean | Buffer | null;

/** Result of a single SQL statement executed via {@link createDatabaseClient}. */
export interface DatabaseExecuteResult {
  /** Column names, in statement order. */
  columns: string[];
  /** Decoded row values. */
  rows: DatabaseValue[][];
  /** Rows affected by INSERT/UPDATE/DELETE, when reported. */
  rowsAffected?: number;
  /** Last inserted rowid, when reported (a string — SQLite rowids can exceed Number.MAX_SAFE_INTEGER). */
  lastInsertRowid?: string;
}

export interface DatabaseClient {
  /**
   * Execute a single raw SQL statement (read or write) with optional
   * positional args. Raw passthrough — no query builder, no dialect
   * filtering (spec §7B): any SQL the underlying database accepts, including
   * FTS5 full-text search and vector-search extensions, works here verbatim.
   */
  execute(sql: string, args?: unknown[]): Promise<DatabaseExecuteResult>;
}

interface HranaValue {
  type: string;
  /**
   * Hrana wire encoding: integers are a STRING (i64 precision safety —
   * SQLite integers exceed what a JS/JSON `number` can represent exactly);
   * floats are a raw JSON `number`. Mixing these up produces a malformed
   * request the real Turso pipeline endpoint rejects or misreads.
   */
  value?: string | number;
  base64?: string;
}

function toHranaValue(v: unknown): HranaValue {
  if (v === null || v === undefined) {
    return { type: 'null' };
  }
  if (typeof v === 'string') {
    return { type: 'text', value: v };
  }
  if (typeof v === 'bigint') {
    return { type: 'integer', value: v.toString() };
  }
  if (typeof v === 'number') {
    // Integer → string (i64 precision safety); float → raw JSON number
    // (Hrana wire contract — see HranaValue.value doc).
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  if (typeof v === 'boolean') {
    return { type: 'integer', value: v ? '1' : '0' };
  }
  if (v instanceof Uint8Array) {
    return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  }
  throw new Error(`[createDatabaseClient] unsupported arg type for value: ${typeof v}`);
}

function fromHranaValue(v: HranaValue | null | undefined): DatabaseValue {
  if (!v || v.type === 'null') {
    return null;
  }
  switch (v.type) {
    case 'text':
      return typeof v.value === 'string' ? v.value : null;
    case 'integer': {
      // Wire value is always a decimal STRING (i64 precision safety). Decode
      // to a number only when it round-trips exactly through a JS double;
      // beyond Number.MAX_SAFE_INTEGER, preserve the original string rather
      // than silently rounding (same rationale as lastInsertRowid).
      if (typeof v.value !== 'string') {
        return null;
      }
      const n = Number(v.value);
      return Number.isSafeInteger(n) ? n : v.value;
    }
    case 'float':
      // Wire value is a raw JSON number already.
      return typeof v.value === 'number' ? v.value : v.value !== undefined ? Number(v.value) : null;
    case 'blob':
      return v.base64 !== undefined ? Buffer.from(v.base64, 'base64') : null;
    default:
      return v.value ?? null;
  }
}

/** Derive the Hrana-over-HTTP base URL from a `libsql://` (or already-`https://`) DatabaseVar.url. */
function httpBaseUrl(url: string): string {
  if (url.startsWith('libsql://')) {
    return `https://${url.slice('libsql://'.length)}`;
  }
  return url;
}

interface HranaPipelineResponse {
  results?: Array<
    | {
        type: 'ok';
        response: {
          type: 'execute';
          result: {
            cols: Array<{ name: string | null }>;
            rows: HranaValue[][];
            affected_row_count?: number;
            last_insert_rowid?: string;
          };
        };
      }
    | { type: 'error'; error: { message: string } }
  >;
}

/**
 * Construct a client for a `DatabaseVar` (`ctx.vars.MYDB`). Raw SQL
 * passthrough via the libSQL Hrana-over-HTTP `/v2/pipeline` endpoint — the
 * `{url, token}` pair works with any libSQL-compatible client; this helper is
 * pure convenience, never blessed as the only way to reach the database.
 */
export function createDatabaseClient(v: DatabaseVar | AnalyticalDatabaseBinding): DatabaseClient {
  if (typeof v === 'string') {
    throw new Error(
      '[createDatabaseClient] received an analytical database binding; use createAnalyticalDatabaseClient instead',
    );
  }
  const base = httpBaseUrl(v.url);
  return {
    async execute(sql: string, args: unknown[] = []): Promise<DatabaseExecuteResult> {
      const res = await fetch(`${base}/v2/pipeline`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${v.token}`,
        },
        body: JSON.stringify({
          requests: [{ type: 'execute', stmt: { sql, args: args.map(toHranaValue) } }, { type: 'close' }],
        }),
      });
      if (!res.ok) {
        throw new Error(`[createDatabaseClient] request failed: ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as HranaPipelineResponse;
      const first = body.results?.[0];
      if (!first) {
        throw new Error('[createDatabaseClient] empty response from database');
      }
      if (first.type === 'error') {
        throw new Error(`[createDatabaseClient] SQL error: ${first.error.message}`);
      }
      const result = first.response.result;
      return {
        columns: result.cols.map((c) => c.name ?? ''),
        rows: result.rows.map((row) => row.map(fromHranaValue)),
        rowsAffected: result.affected_row_count,
        lastInsertRowid: result.last_insert_rowid,
      };
    },
  };
}
