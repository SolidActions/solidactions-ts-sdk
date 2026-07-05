import { serializeError, type ErrorObject } from 'serialize-error';

/**
 * serialize-error@8.1.0 only copies OWN ENUMERABLE properties off an Error.
 * Node's native `new Error(msg, { cause })` defines `.cause` as a
 * NON-enumerable data property, so serializeError() silently drops it and
 * deserializeError() on the far side produces `err.cause === undefined` —
 * even though an EXPLICITLY-enumerable `.cause` round-trips correctly today.
 *
 * Wraps serializeError() and re-attaches up to `depth` levels of the `.cause`
 * chain as an explicit enumerable property, so deserializeError() reconstructs
 * `err.cause.cause...` intact. Bounded (default depth 3) so a pathological or
 * circular chain can't blow up payload size — the app's own 9000-char cap on
 * stored error strings still applies downstream regardless.
 *
 * Scope: src/invoke/invoke.ts (step errors) and
 * src/invoke/run-status-lifecycle.ts (terminal run status) only. The legacy
 * executor (solidactions-executor.ts) and conductor protocol paths are OUT of
 * scope for this fix.
 */
export function serializeErrorWithCause(err: unknown, depth = 3): ErrorObject {
  const serialized = serializeError(err) as ErrorObject & { cause?: unknown };
  if (
    depth > 0 &&
    err !== null &&
    typeof err === 'object' &&
    'cause' in err &&
    (err as { cause?: unknown }).cause !== undefined
  ) {
    serialized.cause = serializeErrorWithCause((err as { cause: unknown }).cause, depth - 1);
  }
  return serialized;
}
