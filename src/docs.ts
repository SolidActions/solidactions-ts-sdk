import { HttpClient } from './http_client';
import { SolidActionsDataValidationError } from './error';

/**
 * Config for SolidActions.docs.create(). Deliberately fully explicit: this
 * SDK never auto-reads SOLIDACTIONS_API_KEY / SOLIDACTIONS_WORKSPACE_ID (or
 * any other reserved SOLIDACTIONS_* / SOLIDACTIONS__* name — see
 * src/invoke/context-adapter.ts's RESERVED_KEYS/isReserved) for this call.
 * Declare your own project env var (e.g. MY_SA_API_KEY, MY_SA_WORKSPACE_ID)
 * and pass the values in here.
 */
export interface DocsCreateConfig {
  /** Workspace API key — a Sanctum personal access token. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Target workspace UUID. Sent as `X-Workspace-Id`. */
  workspaceId: string;
  /** Base URL of the SolidActions app (e.g. https://app.solidactions.com), NOT the internal runner API. */
  baseUrl: string;
  timeout?: number;
  maxRetries?: number;
}

export interface DocsCreateInput {
  title: string;
  body?: string | null;
  properties?: Record<string, unknown> | null;
  folderPath?: string | null;
  folderId?: number | null;
  docTypeId?: number | null;
  type?: string | null;
  /**
   * Sent to the server, but pending server support: `POST /api/v1/docs`
   * currently ignores this field (spec-vs-implementation drift, tracked
   * separately).
   */
  parseFrontmatter?: boolean | null;
  /**
   * Sent to the server, but pending server support: `POST /api/v1/docs`
   * currently ignores this field (spec-vs-implementation drift, tracked
   * separately).
   */
  createMissingFolders?: boolean | null;
  /**
   * Sent as the `Idempotency-Key` header on the POST, but pending server
   * support: `POST /api/v1/docs` currently ignores this header (spec-vs-
   * implementation drift, tracked separately). Until the server honors it,
   * HttpClient's automatic POST retries can duplicate docs on transient
   * 5xx/network failures.
   */
  idempotencyKey?: string;
}

export interface DocTypeRef {
  id: number;
  slug: string;
  name: string;
}

export interface Doc {
  id: number;
  title: string;
  folder_id: number | null;
  folder_path: string | null;
  body: string;
  properties: Record<string, unknown> | unknown[];
  doc_type: DocTypeRef | null;
  current_version_id: number | null;
  body_blob_sha: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface DocsCreateResult {
  doc: Doc;
  warnings: Array<Record<string, unknown>>;
}

/**
 * Create a doc via `POST /api/v1/docs`, authenticated with a workspace API
 * key (Sanctum PAT) + X-Workspace-Id — both supplied explicitly in `config`.
 * `create` only; no `update`/`list` wrappers (YAGNI until asked).
 */
export async function createDoc(input: DocsCreateInput, config: DocsCreateConfig): Promise<DocsCreateResult> {
  if (!config?.apiKey) {
    throw new SolidActionsDataValidationError(
      'SolidActions.docs.create() requires config.apiKey (a workspace API key / Sanctum personal ' +
        'access token). Read it from your own project env var — e.g. process.env.MY_SA_API_KEY — ' +
        'never a reserved SOLIDACTIONS_* name.',
    );
  }
  if (!config?.workspaceId) {
    throw new SolidActionsDataValidationError(
      'SolidActions.docs.create() requires config.workspaceId (the target workspace UUID, sent as ' +
        'X-Workspace-Id). Read it from your own project env var — e.g. process.env.MY_SA_WORKSPACE_ID.',
    );
  }
  if (!config?.baseUrl) {
    throw new SolidActionsDataValidationError(
      'SolidActions.docs.create() requires config.baseUrl (the base URL of the SolidActions app, ' +
        'e.g. https://app.solidactions.com — not the internal runner API).',
    );
  }
  if (!input?.title) {
    throw new SolidActionsDataValidationError('SolidActions.docs.create() requires input.title.');
  }

  const client = new HttpClient({
    baseUrl: `${config.baseUrl.replace(/\/$/, '')}/api/v1`,
    apiKey: config.apiKey,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
  });

  const body: Record<string, unknown> = { title: input.title };
  if (input.body !== undefined) body.body = input.body;
  if (input.properties !== undefined) body.properties = input.properties;
  if (input.folderPath !== undefined) body.folder_path = input.folderPath;
  if (input.folderId !== undefined) body.folder_id = input.folderId;
  if (input.docTypeId !== undefined) body.doc_type_id = input.docTypeId;
  if (input.type !== undefined) body.type = input.type;
  if (input.parseFrontmatter !== undefined) body.parse_frontmatter = input.parseFrontmatter;
  if (input.createMissingFolders !== undefined) body.create_missing_folders = input.createMissingFolders;

  const headers: Record<string, string> = { 'X-Workspace-Id': config.workspaceId };
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;

  return client.post<DocsCreateResult>('/docs', body, { headers });
}
