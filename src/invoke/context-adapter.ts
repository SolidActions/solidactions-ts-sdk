import { SolidActionsJSON } from '../serialization';
import type { InvokeCtx, VarValue, ConnectionVar } from './types';

/**
 * A one-arg adapter signature: converts a flat transport map (e.g. process.env)
 * into a fully-typed InvokeCtx.
 */
export type ContextAdapter = (transport: Record<string, string>) => InvokeCtx;

/**
 * Reserved env keys that are never forwarded into ctx.vars.
 * Any key in this set (or matching the SOLIDACTIONS_ / SOLIDACTIONS__ prefixes)
 * is consumed as a first-class ctx field.
 */
const RESERVED_KEYS = new Set([
  'WORKFLOW_INPUT',
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
 * One-shot adapter: maps the flat env var map that the Daytona one-shot runtime
 * injects into a fully-typed `InvokeCtx<unknown>`.
 *
 * Env var → ctx field mapping:
 *   WORKFLOW_INPUT          → ctx.input  (SolidActionsJSON.parse: SuperJSON-envelope-aware
 *                                         + plain JSON; missing → {}; malformed → throw)
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
 * Missing WORKFLOW_INPUT → input is {} (empty object).
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
export function oneShotContextAdapter(transport: Record<string, string>): InvokeCtx {
  // --- input ---
  let input: unknown = {};
  if (transport['WORKFLOW_INPUT'] !== undefined) {
    try {
      input = SolidActionsJSON.parse(transport['WORKFLOW_INPUT']);
    } catch (err) {
      throw new Error(
        `[ContextAdapter] WORKFLOW_INPUT contains invalid JSON: ${String(err)}`,
      );
    }
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
      const connVar: ConnectionVar = {
        key: value,
        proxyUrl,
        proxyToken,
      };
      vars[key] = connVar;
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
