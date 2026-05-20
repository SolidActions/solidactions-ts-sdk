/**
 * Task 3.2 — Secret redaction for the durable persistence path.
 *
 * The model: a `ConnectionVar` carries two SECRET fields and one non-secret:
 *   - `key`         — the live connection key bytes (SECRET)
 *   - `proxyToken`  — bearer for the run-shared proxy (SECRET)
 *   - `proxyUrl`    — shared infra URL, not sensitive in itself
 *
 * Plain `string` vars are NOT secret (they are tenant config values surfaced
 * through `process.env` that the deploy gate already considers visible).
 * The classification is by SHAPE — anything that satisfies `ConnectionVar` is
 * secret-bearing; the marker is the object shape itself (`key`+`proxyUrl`+
 * `proxyToken`), no separate `secretNames` registry is required. This mirrors
 * the existing type model (`VarValue = string | ConnectionVar`).
 *
 * The two paths this module covers:
 *
 *  1) Snapshot-by-reference. When the durable vars snapshot is written, each
 *     `ConnectionVar` is replaced with a `RedactedConnectionVarRef` carrying
 *     ONLY the var name + the non-secret `proxyUrl`. The persisted snapshot
 *     therefore never contains `key` / `proxyToken` plaintext.
 *
 *     On replay, the snapshot is loaded and the `key`/`proxyToken` are
 *     RE-HYDRATED from the adapter-supplied live `ctx.vars` by name. The
 *     runner re-injects the same connection per dispatch (the connection
 *     store is the source of truth at runtime), so the workflow body sees a
 *     fully-populated `ConnectionVar` indistinguishable from the first
 *     dispatch.
 *
 *     This intentionally relaxes the strict determinism contract from Task 3.1
 *     FOR THE SECRET FIELDS ONLY: if a tenant rotates a connection between
 *     dispatches, the secret bytes change, and the workflow body will see the
 *     new bytes on replay. That divergence is tolerated — secrets are not
 *     under the workflow's control, the connection store is the source of
 *     truth, and the alternative (persisting the secret) is the bug this
 *     task fixes. Non-secret vars retain Task 3.1's snapshot-wins semantics.
 *
 *  2) Output / error scrubbing. Anywhere a secret could leak into a durable
 *     write (step outputs, step errors, log lines), the serialized string is
 *     scrubbed of each known secret value before it crosses the persistence
 *     boundary. The scrubber is a simple "replace every occurrence of each
 *     secret with [REDACTED]" — fine-grained enough for the bytes-on-the-wire
 *     guarantee the task requires.
 *
 * Backward-compat: a legacy unredacted snapshot (written before this fix
 * landed) parses to a plain `Record<string, VarValue>` with no
 * `__redactedConnectionVar` markers; `rehydrateVarsFromSnapshot` then passes
 * it through unchanged — the existing values (including any plaintext
 * secrets that legacy snapshot carries) are used. That snapshot is already
 * leaked at rest; the SDK's job here is to STOP writing new leaks, not to
 * un-leak past ones.
 */

import type { ConnectionVar, VarValue } from './types';

/**
 * Stable marker indicating that a snapshot entry is a reference to a
 * secret-bearing connection var rather than the plaintext value.
 */
const REDACTED_MARKER = '__redactedConnectionVar' as const;

/**
 * Public placeholder substituted for any plaintext secret string that would
 * otherwise have been persisted (step outputs, errors, logs).
 */
export const REDACTED_PLACEHOLDER = '[REDACTED]' as const;

/**
 * Persisted shape of a `ConnectionVar` after snapshot redaction. Carries only
 * the var name (so the loader can look up the live value by name from the
 * adapter-supplied `ctx.vars`) and the non-secret `proxyUrl` (kept so a
 * snapshot-only inspector — e.g. the admin UI — can still distinguish two
 * runs that use different proxies, without leaking any secret bytes).
 */
export interface RedactedConnectionVarRef {
  readonly [REDACTED_MARKER]: true;
  readonly varName: string;
  readonly proxyUrl: string;
}

/**
 * Returns true iff `v` is a `ConnectionVar` (object with `key`+`proxyUrl`+
 * `proxyToken` string fields). This is the same shape predicate the rest of
 * the SDK uses to distinguish ConnectionVar from a plain string var.
 */
export function isConnectionVar(v: unknown): v is ConnectionVar {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { key?: unknown }).key === 'string' &&
    typeof (v as { proxyUrl?: unknown }).proxyUrl === 'string' &&
    typeof (v as { proxyToken?: unknown }).proxyToken === 'string'
  );
}

/**
 * Returns true iff `v` carries the redacted-reference marker.
 */
export function isRedactedConnectionVarRef(v: unknown): v is RedactedConnectionVarRef {
  return typeof v === 'object' && v !== null && (v as { [REDACTED_MARKER]?: unknown })[REDACTED_MARKER] === true;
}

/**
 * Replace each `ConnectionVar` in `vars` with a `RedactedConnectionVarRef`.
 * Plain string vars are left untouched. The returned object is plain
 * (NOT frozen) so it round-trips cleanly through `SolidActionsJSON.stringify`.
 */
export function redactVarsForSnapshot(
  vars: Readonly<Record<string, VarValue>>,
): Record<string, string | RedactedConnectionVarRef> {
  const out: Record<string, string | RedactedConnectionVarRef> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (isConnectionVar(value)) {
      out[name] = {
        [REDACTED_MARKER]: true,
        varName: name,
        proxyUrl: value.proxyUrl,
      };
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Inverse of `redactVarsForSnapshot`: for each `RedactedConnectionVarRef` in
 * the parsed snapshot, re-hydrate the `key`/`proxyToken` from the live
 * adapter-supplied `ctx.vars` by name. Plain string entries are passed
 * through unchanged.
 *
 * Three edge cases:
 *
 *   - The live `ctx.vars[varName]` is a `ConnectionVar` (the expected path).
 *     The re-hydrated value is a `ConnectionVar` carrying the snapshot's
 *     `proxyUrl` (non-secret, snapshot-deterministic) plus the live
 *     `key`/`proxyToken`. This preserves Task 3.1's snapshot-wins semantics
 *     for `proxyUrl` while sourcing secrets from the live store.
 *
 *   - The live `ctx.vars[varName]` is MISSING (env rotated the var out of
 *     the deploy between dispatches). We leave the redacted reference in
 *     place; the workflow body that reads `ctx.vars.X.key` will get an
 *     `undefined` access path, which is the same failure mode the legacy
 *     code would surface if the env var disappeared. No throw here — the
 *     redaction layer's job is to scrub plaintext, not to enforce shape.
 *
 *   - The snapshot was written by a pre-fix legacy SDK (no
 *     `__redactedConnectionVar` markers). Each entry is whatever the legacy
 *     code persisted — pass through unchanged. That snapshot is the pre-fix
 *     leak this task stops introducing; the workflow body still receives a
 *     fully-populated `ConnectionVar`, just from the legacy plaintext
 *     snapshot rather than via re-hydration.
 */
export function rehydrateVarsFromSnapshot(
  snapshotVars: Record<string, unknown>,
  liveVars: Readonly<Record<string, VarValue>>,
): Record<string, VarValue> {
  const out: Record<string, VarValue> = {};
  for (const [name, value] of Object.entries(snapshotVars)) {
    if (isRedactedConnectionVarRef(value)) {
      const live = liveVars[name];
      if (isConnectionVar(live)) {
        // Snapshot-deterministic proxyUrl (T3.1), live secrets (T3.2).
        out[name] = {
          key: live.key,
          proxyUrl: value.proxyUrl,
          proxyToken: live.proxyToken,
        };
      } else {
        // Live var missing or shape-mismatched — preserve the redacted ref
        // verbatim (degraded mode). The workflow body's read path will
        // surface the absence in its own way; this layer does not throw.
        out[name] = value as unknown as VarValue;
      }
    } else if (typeof value === 'string' || isConnectionVar(value)) {
      out[name] = value as VarValue;
    } else {
      // Defensive: unknown shape (legacy / corrupt) → coerce to a string
      // representation so the workflow body sees SOMETHING typed; this
      // preserves Task 3.1's pass-through behavior for unrecognized shapes.
      out[name] = String(value);
    }
  }
  return out;
}

/**
 * Collect the plaintext secret strings (key + proxyToken) of every
 * ConnectionVar in `vars`. Used to build the secret set that
 * `scrubSecretsFromString` removes from any serialized payload before it
 * crosses the persistence boundary.
 *
 * Returns a deduplicated, length-descending array so the scrubber replaces
 * longer secrets first (avoids partial-overlap bugs where a shorter secret
 * happens to be a substring of a longer one).
 */
export function collectSecretStrings(vars: Readonly<Record<string, VarValue>>): string[] {
  const set = new Set<string>();
  for (const value of Object.values(vars)) {
    if (isConnectionVar(value)) {
      if (value.key.length > 0) set.add(value.key);
      if (value.proxyToken.length > 0) set.add(value.proxyToken);
    }
  }
  // Sort longest-first so containing-substring replacements happen before
  // the contained-substring ones.
  return Array.from(set).sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of each secret in `input` with the placeholder.
 * Idempotent and order-independent; safe to call on already-scrubbed strings.
 * If `secrets` is empty, returns `input` verbatim (zero-cost no-op).
 */
export function scrubSecretsFromString(input: string, secrets: readonly string[]): string {
  if (secrets.length === 0) {
    return input;
  }
  let out = input;
  for (const s of secrets) {
    if (s.length === 0) continue;
    // String.replaceAll with a string argument is literal — no regex escape
    // concerns; available in Node ≥ 15 which the SDK already targets.
    out = out.split(s).join(REDACTED_PLACEHOLDER);
  }
  return out;
}
