/**
 * `ctx.docs` — the run-scoped docs client (docs-access-w1, sdk#23).
 *
 * Every verb is one `POST {apiUrl}/runs/{runId}/docs/{verb}` with the run's
 * Bearer key (`SOLIDACTIONS_API_KEY`). The server decides what the run's app may
 * see; this client only shapes the request and maps the reply.
 *
 * It calls global `fetch` directly and never retries. `HttpClient` retries 5xx up
 * to three times, which would repeat a write, and its error mapping drops the
 * `code` field this client needs. A write that must survive a replay belongs in
 * `ctx.step(...)`.
 */
import { SolidActionsDocsError } from '../error';
import type { DocsVar } from './types';

/** A doc or folder reference: a workspace-relative path, a numeric id, or a {@link DocsVar}. */
export type DocRef = string | number | DocsVar;

export type DocsKind = 'doc' | 'folder';

export interface DocsDoc {
  id: number;
  title: string;
  folder_id: number;
  /** The doc type's slug, or null. */
  type: string | null;
  properties: Record<string, unknown>;
  body: string;
  /** The current revision id; pass it as `baseRevision` to guard a write. */
  revision: number;
  updated_at: string;
}

/** A doc as `list` and `search` return it: no body. */
export type DocsListedDoc = Omit<DocsDoc, 'body'>;

export interface DocsFolder {
  id: number;
  name: string;
  parent_id: number | null;
}

export interface DocsPage {
  docs: DocsListedDoc[];
  next_cursor: string | null;
}

export interface DocsListOptions {
  type?: string;
  /** Exact-match filter: property name to value. */
  where?: Record<string, unknown>;
  /** 1-100, default 100. */
  limit?: number;
  cursor?: string;
}

export interface DocsSearchOptions {
  within?: DocRef;
  type?: string;
  limit?: number;
  cursor?: string;
}

export interface DocsCreateOptions {
  title: string;
  body?: string;
  properties?: Record<string, unknown>;
  /** A doc type slug. */
  type?: string;
}

export interface DocsWriteOptions {
  title?: string;
  body?: string;
  properties?: Record<string, unknown>;
  /** Fails with `doc_stale` when it is not the doc's current revision. */
  baseRevision?: number;
}

/** The kind of a bare numeric id on a verb that takes docs and folders. A {@link DocsVar} already carries its own. */
export interface DocsKindOption {
  kind?: DocsKind;
}

export interface DocsClient {
  read(ref: DocRef): Promise<DocsDoc>;
  list(folder: DocRef, options?: DocsListOptions): Promise<DocsPage>;
  search(q: string, options?: DocsSearchOptions): Promise<DocsPage>;
  create(folder: DocRef, input: DocsCreateOptions): Promise<DocsDoc>;
  write(ref: DocRef, input: DocsWriteOptions): Promise<DocsDoc>;
  append(ref: DocRef, text: string): Promise<DocsDoc>;
  prepend(ref: DocRef, text: string): Promise<DocsDoc>;
  updateProperties(ref: DocRef, patch: Record<string, unknown>): Promise<DocsDoc>;
  setType(ref: DocRef, type: string | null): Promise<DocsDoc>;
  rename(ref: DocRef, title: string): Promise<DocsDoc>;
  /** Moves a doc (resolves `DocsDoc`) or a folder (resolves `DocsFolder`). */
  move(ref: DocRef, folder: DocRef, options?: DocsKindOption): Promise<DocsDoc | DocsFolder>;
  /** Copies one doc; a folder ref fails with `copy_folder_unsupported`. */
  copy(ref: DocRef, folder: DocRef, options?: { title?: string }): Promise<DocsDoc>;
  trash(ref: DocRef, options?: DocsKindOption): Promise<{ trashed: true }>;
  restore(id: number, kind: DocsKind): Promise<{ restored: true }>;
  createFolder(parent: DocRef, name: string): Promise<DocsFolder>;
}

export interface DocsClientConfig {
  /** The run API base, e.g. `ctx.api.url`. */
  apiUrl: string;
  /** The run's Bearer key, `ctx.api.key`. */
  apiKey: string;
  /** The workflow run uuid, `ctx.run.runUuid`. */
  runId: string;
  workerSessionId?: string;
}

type WireRef = ({ id: number } | { path: string }) & { kind?: DocsKind };

const REQUEST_TIMEOUT_MS = 60_000;

/** Error-body fields that have their own property on {@link SolidActionsDocsError}. */
const NAMED_ERROR_FIELDS = new Set(['code', 'message', 'path']);

function toRef(ref: DocRef, kind?: DocsKind): WireRef {
  const withKind = (r: { id: number } | { path: string }, k?: DocsKind): WireRef => (k ? { ...r, kind: k } : r);
  if (typeof ref === 'number') return withKind({ id: ref }, kind);
  if (typeof ref === 'string') return withKind({ path: ref }, kind);
  return withKind(ref.id !== null ? { id: ref.id } : { path: ref.path }, ref.kind);
}

function errorFrom(status: number, text: string): SolidActionsDocsError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const code = typeof body['code'] === 'string' ? body['code'] : 'unknown';
  const message = typeof body['message'] === 'string' ? body['message'] : `Docs request failed with status ${status}`;
  const path = typeof body['path'] === 'string' ? body['path'] : undefined;
  const extra = Object.fromEntries(Object.entries(body).filter(([key]) => !NAMED_ERROR_FIELDS.has(key)));
  return new SolidActionsDocsError({
    code,
    status,
    message,
    ...(path !== undefined ? { path } : {}),
    ...(Object.keys(extra).length > 0 ? { details: extra } : {}),
  });
}

export function createDocsClient(config: DocsClientConfig): DocsClient {
  const base = config.apiUrl.replace(/\/+$/, '');

  async function call(verb: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (config.workerSessionId) {
      headers['X-Worker-Session-ID'] = config.workerSessionId;
    }
    const res = await fetch(`${base}/runs/${encodeURIComponent(config.runId)}/docs/${verb}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw errorFrom(res.status, text);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw errorFrom(res.status, '');
    }
  }

  const doc = async (verb: string, body: Record<string, unknown>): Promise<DocsDoc> =>
    (await call(verb, body))['doc'] as DocsDoc;

  return {
    read: (ref) => doc('read', { ref: toRef(ref) }),
    list: async (folder, options = {}) =>
      (await call('list', {
        folder: toRef(folder),
        type: options.type,
        where: options.where,
        limit: options.limit,
        cursor: options.cursor,
      })) as unknown as DocsPage,
    search: async (q, options = {}) =>
      (await call('search', {
        q,
        within: options.within !== undefined ? toRef(options.within) : undefined,
        type: options.type,
        limit: options.limit,
        cursor: options.cursor,
      })) as unknown as DocsPage,
    create: (folder, input) =>
      doc('create', {
        folder: toRef(folder),
        title: input.title,
        body: input.body,
        properties: input.properties,
        type: input.type,
      }),
    write: (ref, input) =>
      doc('write', {
        ref: toRef(ref),
        title: input.title,
        body: input.body,
        properties: input.properties,
        base_revision: input.baseRevision,
      }),
    append: (ref, text) => doc('append', { ref: toRef(ref), text }),
    prepend: (ref, text) => doc('prepend', { ref: toRef(ref), text }),
    updateProperties: (ref, patch) => doc('updateProperties', { ref: toRef(ref), patch }),
    setType: (ref, type) => doc('setType', { ref: toRef(ref), type }),
    rename: (ref, title) => doc('rename', { ref: toRef(ref), title }),
    move: async (ref, folder, options = {}) => {
      const reply = await call('move', { ref: toRef(ref, options.kind), folder: toRef(folder) });
      return (reply['folder'] ?? reply['doc']) as DocsDoc | DocsFolder;
    },
    copy: (ref, folder, options = {}) => doc('copy', { ref: toRef(ref), folder: toRef(folder), title: options.title }),
    trash: async (ref, options = {}) =>
      (await call('trash', { ref: toRef(ref, options.kind) })) as unknown as { trashed: true },
    restore: async (id, kind) => (await call('restore', { id, kind })) as unknown as { restored: true },
    createFolder: async (parent, name) =>
      (await call('createFolder', { parent: toRef(parent), name }))['folder'] as DocsFolder,
  };
}
