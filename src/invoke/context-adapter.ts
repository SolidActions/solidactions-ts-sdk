import { SolidActionsJSON } from '../serialization';
import type { InvokeCtx, VarValue, ConnectionVar, ConnectionBroker } from './types';

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
 * @param url - The URL to fetch from.
 * @param tag - Prefix used in error messages (e.g. `'ContextAdapter'`).
 */
async function fetchWorkflowInput(url: string, tag: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
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
    input = await fetchWorkflowInput(transport['WORKFLOW_INPUT_URL'], 'ContextAdapter');
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
  const proxyUrl = transport['SA_PROXY_URL'];
  const proxyToken = transport['SA_PROXY_TOKEN'];
  const hasProxy = proxyUrl !== undefined && proxyToken !== undefined;

  const vars: Record<string, VarValue> = {};
  for (const [key, value] of Object.entries(transport)) {
    if (isReserved(key)) {
      continue;
    }
    if (hasProxy && isConnectionValue(value)) {
      // No broker signal in the one-shot transport → broker omitted (the
      // returned shape stays `{ key, proxyUrl, proxyToken }`, runtime-identical
      // to the pre-broker-typing behavior).
      vars[key] = makeConnectionVar(value, proxyUrl, proxyToken);
    } else {
      vars[key] = value;
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
    input = await fetchWorkflowInput(env['WORKFLOW_INPUT_URL'], 'ResidentContextAdapter');
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

  // --- vars (same classification as oneShotContextAdapter) ---
  const proxyUrl = env['SA_PROXY_URL'];
  const proxyToken = env['SA_PROXY_TOKEN'];
  const hasProxy = proxyUrl !== undefined && proxyToken !== undefined;
  const vars: Record<string, VarValue> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isReserved(key)) {
      continue;
    }
    if (hasProxy && isConnectionValue(value)) {
      vars[key] = makeConnectionVar(value, proxyUrl, proxyToken);
    } else {
      vars[key] = value;
    }
  }

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
