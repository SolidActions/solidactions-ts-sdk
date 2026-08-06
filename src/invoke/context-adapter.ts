import { SolidActionsJSON } from '../serialization';
import type { InvokeCtx, VarValue, ConnectionVar, ConnectionBroker, DatabaseVar } from './types';

/**
 * Broker typing for connection vars (Task 6.2).
 *
 * A {@link ConnectionVar} now carries an OPTIONAL `broker` field
 * ({@link ConnectionBroker}). The supported broker is `'pica'`; `'composio'` is
 * DEPRECATED and will not be carried by the new ctx.vars path — the migration
 * codemod (`src/migrate/codemod.ts`) reports any declared Composio connection.
 *
 * The interim one-shot transport (a flat env map) has NO broker signal, so this
 * adapter does NOT emit a `broker` field at runtime — it stays `undefined`,
 * which keeps existing `toEqual({ key, proxyUrl, proxyToken })` assertions and
 * the replay snapshot byte-for-byte unchanged. Once the runtime transport
 * surfaces the broker (alongside `SA_PROXY_URL`/`SA_PROXY_TOKEN`), populate it
 * via {@link makeConnectionVar} below; Pica is the only non-deprecated value.
 */
export type { ConnectionBroker };

/**
 * A one-arg adapter signature: converts a flat transport map (e.g. process.env)
 * into a fully-typed InvokeCtx.
 */
export type ContextAdapter = (transport: Record<string, string>) => Promise<InvokeCtx>;

/**
 * Reserved env keys that are never forwarded into ctx.vars.
 * Any key in this set (or matching the SOLIDACTIONS_ / SOLIDACTIONS__ prefixes)
 * is consumed as a first-class ctx field.
 */
const RESERVED_KEYS = new Set([
  'WORKFLOW_INPUT',
  'WORKFLOW_INPUT_URL',
  'STEPS_TRIGGER_ID',
  'TENANT_ID',
  'SA_PROXY_URL',
  'SA_PROXY_TOKEN',
  'WORKFLOW_SLUG',
  'SOLIDACTIONS__DB_KEYS',
]);

/** Returns true if the key is reserved (used as a first-class ctx field, not a var). */
function isReserved(key: string): boolean {
  if (RESERVED_KEYS.has(key)) {
    return true;
  }
  // Any key starting with SOLIDACTIONS_ or SOLIDACTIONS__ is reserved.
  if (key.startsWith('SOLIDACTIONS_') || key.startsWith('SOLIDACTIONS__')) {
    return true;
  }
  return false;
}

/**
 * Reserved key carrying a comma-separated allowlist of the tenant-declared var
 * keys, emitted by Laravel's `RuntimeEnvBuilder` (it equals every non-reserved
 * key it injected — project variables + OAuth/connection `env_name`s).
 *
 * When present it is AUTHORITATIVE: `ctx.vars` is built from exactly these keys,
 * so container base env (`PATH`, `HOME`, `NODE_VERSION`, …) never pollutes
 * `ctx.vars`. The one-shot adapter additionally deletes these keys from the
 * transport (process.env), making `ctx.vars` the single way to read them.
 *
 * When ABSENT (legacy deploys, local/mock transports) the adapters fall back to
 * scanning every non-reserved key — the pre-manifest behavior — and the
 * one-shot adapter does NOT scrub, since without an authoritative list deleting
 * would risk removing container base env like `PATH`.
 */
const VAR_KEYS_MANIFEST = 'SOLIDACTIONS__VAR_KEYS';

/**
 * Reserved key carrying a comma-separated allowlist of the env names that are
 * workspace-database mappings (issue #1127, spec §4A). Emitted by Laravel's
 * `RuntimeEnvBuilder` alongside {@link VAR_KEYS_MANIFEST} (which also includes
 * these keys). Classification by this manifest is deterministic — no
 * value-shape heuristic like `isConnectionValue` — so a database mapping's env
 * value is always parsed as JSON into a {@link DatabaseVar}, never guessed at.
 */
const DB_KEYS_MANIFEST = 'SOLIDACTIONS__DB_KEYS';

/**
 * Resolve which transport keys are tenant vars: the {@link VAR_KEYS_MANIFEST}
 * allowlist when present (filtered to keys actually present and non-reserved),
 * otherwise every non-reserved key (legacy fallback).
 */
function resolveVarKeys(transport: Record<string, string>): string[] {
  const manifest = transport[VAR_KEYS_MANIFEST];
  if (manifest !== undefined) {
    return manifest
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0 && !isReserved(key) && transport[key] !== undefined);
  }
  return Object.keys(transport).filter((key) => !isReserved(key));
}

/**
 * Resolve the set of transport keys that are database mappings, from the
 * {@link DB_KEYS_MANIFEST} allowlist. Absent manifest → empty set (no
 * database vars — legacy/local transports never classify by shape).
 */
function resolveDbKeys(transport: Record<string, string>): Set<string> {
  const manifest = transport[DB_KEYS_MANIFEST];
  if (manifest === undefined) {
    return new Set();
  }
  return new Set(
    manifest
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
  );
}

/**
 * Parse a database mapping's env JSON value into a {@link DatabaseVar}
 * `{name, url, token, readOnly}` (from the JSON's `name`/`url`/`token`/
 * `read_only` fields — spec §4A). Malformed JSON, or JSON that doesn't match
 * the expected shape, is left as the raw string — defensive, matches the
 * SDK's existing posture of never throwing on an unexpected env shape.
 */
function parseDatabaseVar(value: string): DatabaseVar | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>)['name'] === 'string' &&
    typeof (parsed as Record<string, unknown>)['url'] === 'string' &&
    typeof (parsed as Record<string, unknown>)['token'] === 'string' &&
    typeof (parsed as Record<string, unknown>)['read_only'] === 'boolean'
  ) {
    const obj = parsed as { name: string; url: string; token: string; read_only: boolean };
    return { name: obj.name, url: obj.url, token: obj.token, readOnly: obj.read_only };
  }
  return value;
}

/**
 * Build `ctx.vars` from the resolved key list, classifying each value as a
 * {@link DatabaseVar} (manifest-driven, {@link DB_KEYS_MANIFEST}), a
 * {@link ConnectionVar} (when `SA_PROXY_URL`/`SA_PROXY_TOKEN` are present and
 * the value looks like a connection key), or a scalar string.
 */
function buildVars(transport: Record<string, string>, keys: string[], dbKeys: Set<string>): Record<string, VarValue> {
  const proxyUrl = transport['SA_PROXY_URL'];
  const proxyToken = transport['SA_PROXY_TOKEN'];
  const hasProxy = proxyUrl !== undefined && proxyToken !== undefined;

  const vars: Record<string, VarValue> = {};
  for (const key of keys) {
    const value = transport[key];
    if (dbKeys.has(key)) {
      vars[key] = parseDatabaseVar(value);
    } else if (hasProxy && isConnectionValue(value)) {
      // No broker signal in the flat transport → broker omitted (the returned
      // shape stays `{ key, proxyUrl, proxyToken }`, runtime-identical to the
      // pre-broker-typing behavior).
      vars[key] = makeConnectionVar(value, proxyUrl, proxyToken);
    } else {
      vars[key] = value;
    }
  }
  return vars;
}

/**
 * INTERIM HEURISTIC (Task 4.1 replaces this with the declared connection set from solidactions.yaml):
 *
 * A var value is a connection key iff it matches the pattern *::*::*  — at least two
 * `::` separators, making it a multi-segment opaque string that Pica-style connection
 * keys are expected to use (e.g. `live::gcal::abc|u`).
 *
 * This is intentionally conservative:
 *   - `on`                → 0 `::` → scalar (MY_FLAG case)
 *   - `live::gcal::abc|u` → 2 `::` → connection (GCAL case)
 *   - A plain URL like `http://example.com` contains no `::` → scalar
 *   - A value like `a::b` (1 separator, not 2) → also scalar (conservative threshold)
 *
 * SA_PROXY_URL and SA_PROXY_TOKEN must both be present in the transport for any
 * connection var to be constructed; without them we fall back to scalar regardless
 * of value shape.
 */
function isConnectionValue(value: string): boolean {
  // Count occurrences of `::`; connection keys have at least two segments (`a::b::c`).
  let count = 0;
  let idx = value.indexOf('::');
  while (idx !== -1) {
    count++;
    idx = value.indexOf('::', idx + 2);
  }
  return count >= 2;
}

/**
 * Construct a {@link ConnectionVar}. `broker` is attached ONLY when supplied —
 * when omitted the returned object has exactly `{ key, proxyUrl, proxyToken }`,
 * preserving byte-for-byte equality with the pre-broker-typing shape (callers
 * and the replay snapshot are unaffected). `'composio'` is deprecated; prefer
 * `'pica'`.
 */
export function makeConnectionVar(
  key: string,
  proxyUrl: string,
  proxyToken: string,
  broker?: ConnectionBroker,
): ConnectionVar {
  const connVar: ConnectionVar = { key, proxyUrl, proxyToken };
  if (broker !== undefined) {
    return { ...connVar, broker };
  }
  return connVar;
}

/**
 * Fetches workflow input from a URL with a 30-second timeout, then parses it
 * with SolidActionsJSON.  Used by both adapters to eliminate duplication.
 *
 * The endpoint (`/api/internal/workflow-input`) is protected by the
 * `VerifyRunnerSecret` middleware in `bearer_only` mode — it requires an
 * `Authorization: Bearer <triggerId>:<runSecret>` header.  `apiKey` is the
 * full `SOLIDACTIONS_API_KEY` value (`triggerId:runSecret`), which is exactly
 * what the middleware validates via `RunTrigger.run_secret`.
 *
 * @param url    - The URL to fetch from.
 * @param tag    - Prefix used in error messages (e.g. `'ContextAdapter'`).
 * @param apiKey - The `SOLIDACTIONS_API_KEY` value; sent as `Bearer` token.
 */
async function fetchWorkflowInput(url: string, tag: string, apiKey: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`[${tag}] WORKFLOW_INPUT_URL fetch timed out after 30s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`[${tag}] WORKFLOW_INPUT_URL fetch failed: ${res.status} ${res.statusText}`);
  }
  const raw = await res.text();
  try {
    return SolidActionsJSON.parse(raw);
  } catch (err) {
    throw new Error(`[${tag}] WORKFLOW_INPUT_URL contains invalid JSON: ${String(err)}`);
  }
}

/**
 * One-shot adapter: maps the flat env var map that the Daytona one-shot runtime
 * injects into a fully-typed `InvokeCtx<unknown>`.
 *
 * Env var → ctx field mapping:
 *   WORKFLOW_INPUT          → ctx.input  (SolidActionsJSON.parse: SuperJSON-envelope-aware
 *                                         + plain JSON; missing → {}; malformed → throw)
 *   WORKFLOW_INPUT_URL      → ctx.input  (fetched + SolidActionsJSON.parse when
 *                                         WORKFLOW_INPUT is absent; non-ok HTTP → throw;
 *                                         malformed body → throw)
 *   SOLIDACTIONS_RUN_ID     → ctx.run.runUuid
 *   STEPS_TRIGGER_ID        → ctx.run.triggerId
 *   SOLIDACTIONS_API_KEY    → ctx.run.runSecret (the part after the first `:`)
 *                           → ctx.api.key       (the whole value)
 *   SOLIDACTIONS_WORKER_SESSION_ID → ctx.run.workerSessionId
 *   SOLIDACTIONS_API_URL    → ctx.api.url
 *   SOLIDACTIONS__APPID     → ctx.app.appId
 *   SOLIDACTIONS__APPVERSION → ctx.app.appVersion
 *   TENANT_ID               → ctx.app.tenantId
 *   SA_PROXY_URL            → used as proxyUrl for connection vars
 *   SA_PROXY_TOKEN          → used as proxyToken for connection vars
 *   Everything else         → ctx.vars (classified as ConnectionVar or scalar string)
 *
 * Missing WORKFLOW_INPUT → falls back to WORKFLOW_INPUT_URL if present, else input is {}.
 * Malformed JSON in WORKFLOW_INPUT → throws a descriptive Error immediately.
 *
 * Deserialization uses the canonical `SolidActionsJSON.parse` — the SAME helper
 * the rest of the SDK uses for inputs/outputs (e.g. invoke.ts recv/step replay,
 * child-workflow.ts getResult()). It transparently handles BOTH:
 *   - SuperJSON-enveloped payloads `{"json":...,"__solidactions_serializer":"superjson"}`
 *     — what child-workflow-dispatched runs deliver — unwrapping to the real,
 *     fully-typed value (Date, Map, Set, BigInt, Buffer, …).
 *   - Plain JSON (e.g. webhook triggers send `{"taskId":...}` with no marker),
 *     which falls through to the legacy reviver path and is returned unchanged.
 * Raw JSON.parse here was the defect: it returned the SuperJSON envelope itself
 * for child-dispatched runs, so all input-derived fields came out null/undefined.
 */
export async function oneShotContextAdapter(transport: Record<string, string>): Promise<InvokeCtx> {
  // --- input: WORKFLOW_INPUT, else WORKFLOW_INPUT_URL (fetched), else {} ---
  let input: unknown = {};
  if (transport['WORKFLOW_INPUT'] !== undefined) {
    try {
      input = SolidActionsJSON.parse(transport['WORKFLOW_INPUT']);
    } catch (err) {
      throw new Error(`[ContextAdapter] WORKFLOW_INPUT contains invalid JSON: ${String(err)}`);
    }
  } else if (transport['WORKFLOW_INPUT_URL'] !== undefined) {
    input = await fetchWorkflowInput(
      transport['WORKFLOW_INPUT_URL'],
      'ContextAdapter',
      transport['SOLIDACTIONS_API_KEY'] ?? '',
    );
  }

  // --- run ---
  const apiKey = transport['SOLIDACTIONS_API_KEY'] ?? '';
  const colonIdx = apiKey.indexOf(':');
  const runSecret = colonIdx !== -1 ? apiKey.slice(colonIdx + 1) : '';

  const run = {
    runUuid: transport['SOLIDACTIONS_RUN_ID'] ?? '',
    triggerId: transport['STEPS_TRIGGER_ID'] ?? '',
    runSecret,
    workerSessionId: transport['SOLIDACTIONS_WORKER_SESSION_ID'] ?? '',
  };

  // --- api ---
  const api = {
    url: transport['SOLIDACTIONS_API_URL'] ?? '',
    key: apiKey,
  };

  // --- app ---
  const app = {
    appId: transport['SOLIDACTIONS__APPID'] ?? '',
    appVersion: transport['SOLIDACTIONS__APPVERSION'] ?? '',
    tenantId: transport['TENANT_ID'] ?? '',
  };

  // --- workflow identity ---
  // Injected by RuntimeEnvBuilder; equals app workflows.slug. Absent for
  // mock/local/older deploys (kept optional so legacy paths are unchanged).
  const workflowSlug = transport['WORKFLOW_SLUG'];

  // --- vars ---
  const varKeys = resolveVarKeys(transport);
  const vars = buildVars(transport, varKeys, resolveDbKeys(transport));

  // Single source of truth: when the manifest is present, scrub the tenant var
  // keys from the transport (process.env) so workflow code can only reach them
  // via ctx.vars — eliminating the "is it process.env.X or ctx.vars.X?"
  // confusion. Reserved framework keys are deliberately NOT scrubbed (the SDK's
  // own internals still read SOLIDACTIONS_*/SA_PROXY_* from process.env), and
  // container base env (PATH/HOME/…) is never in varKeys. Skipped without a
  // manifest: with no authoritative list, deleting could remove base env.
  if (transport[VAR_KEYS_MANIFEST] !== undefined) {
    for (const key of varKeys) {
      delete transport[key];
    }
  }

  return {
    input,
    vars: Object.freeze(vars),
    run,
    app,
    api,
    mode: 'oneshot',
    ...(workflowSlug !== undefined ? { workflowSlug } : {}),
    // telemetry omitted: no env signal for it in the one-shot transport
  };
}

/** The dispatched resident /run body (POC resident.mjs / spec dispatch contract). */
export interface ResidentRunBody {
  triggerId: string | number;
  runSecret: string;
  workerSessionId?: string;
  envVars: Record<string, string>;
}

/**
 * Resident adapter: maps the dispatched /run BODY into a fully-typed
 * InvokeCtx<unknown> with mode 'resident'.
 *
 * Differs from oneShotContextAdapter (which reads a flat process.env map):
 *  - identity/transport come from `body.envVars` (NEVER process.env);
 *  - triggerId/runSecret/workerSessionId come from the body top-level, falling
 *    back to envVars (STEPS_TRIGGER_ID / SOLIDACTIONS_WORKER_SESSION_ID);
 *  - input comes from envVars.WORKFLOW_INPUT, OR — when absent — is FETCHED from
 *    envVars.WORKFLOW_INPUT_URL (the large-payload fallback);
 *  - both forms are parsed with SolidActionsJSON.parse (superjson-envelope aware);
 *  - the callback base URL is envVars.SOLIDACTIONS_API_URL.
 */
export async function residentContextAdapter(body: ResidentRunBody): Promise<InvokeCtx> {
  const env = body.envVars ?? {};

  // --- input: WORKFLOW_INPUT, else WORKFLOW_INPUT_URL (fetched), else {} ---
  let input: unknown = {};
  if (env['WORKFLOW_INPUT'] !== undefined) {
    try {
      input = SolidActionsJSON.parse(env['WORKFLOW_INPUT']);
    } catch (err) {
      throw new Error(`[ResidentContextAdapter] WORKFLOW_INPUT contains invalid JSON: ${String(err)}`);
    }
  } else if (env['WORKFLOW_INPUT_URL'] !== undefined) {
    input = await fetchWorkflowInput(
      env['WORKFLOW_INPUT_URL'],
      'ResidentContextAdapter',
      env['SOLIDACTIONS_API_KEY'] ?? '',
    );
  }

  // --- run identity: body top-level, falling back to envVars ---
  const apiKey = env['SOLIDACTIONS_API_KEY'] ?? '';
  const colonIdx = apiKey.indexOf(':');
  const runSecretFromKey = colonIdx !== -1 ? apiKey.slice(colonIdx + 1) : '';
  const run = {
    runUuid: env['SOLIDACTIONS_RUN_ID'] ?? '',
    triggerId: String(body.triggerId ?? env['STEPS_TRIGGER_ID'] ?? ''),
    runSecret: body.runSecret ?? runSecretFromKey,
    workerSessionId: env['SOLIDACTIONS_WORKER_SESSION_ID'] ?? body.workerSessionId ?? '',
  };

  const api = { url: env['SOLIDACTIONS_API_URL'] ?? '', key: apiKey };
  const app = {
    appId: env['SOLIDACTIONS__APPID'] ?? '',
    appVersion: env['SOLIDACTIONS__APPVERSION'] ?? '',
    tenantId: env['TENANT_ID'] ?? '',
  };
  const workflowSlug = env['WORKFLOW_SLUG'];

  // --- vars (same classification as oneShotContextAdapter via the shared
  // helpers: manifest allowlist when present, else scan non-reserved keys).
  // No scrub here — the resident adapter reads a per-run request body, not the
  // shared process.env, so there is nothing to de-duplicate. ---
  const vars = buildVars(env, resolveVarKeys(env), resolveDbKeys(env));

  return {
    input,
    vars: Object.freeze(vars),
    run,
    app,
    api,
    mode: 'resident',
    ...(workflowSlug !== undefined ? { workflowSlug } : {}),
  };
}
