/**
 * Issue #1127 — `DatabaseVar` classification, snapshot redaction/rehydration,
 * and secret scrubbing (spec §4A). Mirrors the existing ConnectionVar tests'
 * shape and conventions.
 *
 * TDD: written before the implementation; tests are the spec.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 * No mocks/spies/stubs/fakes per project testing rules.
 */
import { oneShotContextAdapter, residentContextAdapter } from '../../src/invoke/context-adapter';
import {
  redactVarsForSnapshot,
  rehydrateVarsFromSnapshot,
  collectSecretStrings,
  isDatabaseVar,
  isRedactedDatabaseVarRef,
} from '../../src/invoke/secret-redaction';
import type { DatabaseVar } from '../../src/invoke/types';

const MANIFEST_JSON = JSON.stringify({
  name: 'analytics',
  url: 'libsql://analytics-ws-abc.turso.io',
  token: 'jwt-original',
  read_only: false,
});

// ---------------------------------------------------------------------------
// Manifest classification: SOLIDACTIONS__DB_KEYS drives DatabaseVar parsing
// ---------------------------------------------------------------------------

describe('context-adapter: SOLIDACTIONS__DB_KEYS manifest classification', () => {
  it('a key listed in SOLIDACTIONS__DB_KEYS parses its JSON value into a DatabaseVar', async () => {
    const ctx = await oneShotContextAdapter({
      SOLIDACTIONS__DB_KEYS: 'MYDB',
      MYDB: MANIFEST_JSON,
      SOLIDACTIONS_RUN_ID: 'ru',
    });
    expect(ctx.vars.MYDB).toEqual({
      name: 'analytics',
      url: 'libsql://analytics-ws-abc.turso.io',
      token: 'jwt-original',
      readOnly: false,
    });
  });

  it('a JSON string value NOT listed in the manifest stays a plain string (not shape-guessed)', async () => {
    const ctx = await oneShotContextAdapter({
      OTHER: MANIFEST_JSON,
      SOLIDACTIONS_RUN_ID: 'ru',
    });
    expect(ctx.vars.OTHER).toBe(MANIFEST_JSON);
  });

  it('SOLIDACTIONS__DB_KEYS itself never lands in ctx.vars', async () => {
    const ctx = await oneShotContextAdapter({
      SOLIDACTIONS__DB_KEYS: 'MYDB',
      MYDB: MANIFEST_JSON,
      SOLIDACTIONS_RUN_ID: 'ru',
    });
    expect(Object.keys(ctx.vars)).not.toContain('SOLIDACTIONS__DB_KEYS');
  });

  it('malformed JSON on a manifest-listed key is left as the raw string (defensive)', async () => {
    const ctx = await oneShotContextAdapter({
      SOLIDACTIONS__DB_KEYS: 'MYDB',
      MYDB: 'not valid json {{{',
      SOLIDACTIONS_RUN_ID: 'ru',
    });
    expect(ctx.vars.MYDB).toBe('not valid json {{{');
  });

  it('JSON that is valid but missing required DatabaseVar fields is left as the raw string', async () => {
    const badShape = JSON.stringify({ name: 'analytics', url: 'libsql://x' }); // missing token, read_only
    const ctx = await oneShotContextAdapter({
      SOLIDACTIONS__DB_KEYS: 'MYDB',
      MYDB: badShape,
      SOLIDACTIONS_RUN_ID: 'ru',
    });
    expect(ctx.vars.MYDB).toBe(badShape);
  });

  it('residentContextAdapter classifies database keys the same way', async () => {
    const ctx = await residentContextAdapter({
      triggerId: 't',
      runSecret: 's',
      envVars: {
        SOLIDACTIONS__DB_KEYS: 'MYDB',
        MYDB: MANIFEST_JSON,
      },
    });
    expect(ctx.vars.MYDB).toEqual({
      name: 'analytics',
      url: 'libsql://analytics-ws-abc.turso.io',
      token: 'jwt-original',
      readOnly: false,
    });
  });

  it('multiple comma-separated manifest keys all classify as DatabaseVar', async () => {
    const secondJson = JSON.stringify({
      name: 'orders',
      url: 'libsql://orders-ws-xyz.turso.io',
      token: 'jwt-second',
      read_only: true,
    });
    const ctx = await oneShotContextAdapter({
      SOLIDACTIONS__DB_KEYS: 'MYDB,SECONDDB',
      MYDB: MANIFEST_JSON,
      SECONDDB: secondJson,
      SOLIDACTIONS_RUN_ID: 'ru',
    });
    expect(isDatabaseVar(ctx.vars.MYDB)).toBe(true);
    expect(ctx.vars.SECONDDB).toEqual({
      name: 'orders',
      url: 'libsql://orders-ws-xyz.turso.io',
      token: 'jwt-second',
      readOnly: true,
    });
  });
});

// ---------------------------------------------------------------------------
// isDatabaseVar shape predicate
// ---------------------------------------------------------------------------

describe('isDatabaseVar', () => {
  it('recognizes a well-formed DatabaseVar', () => {
    const v: DatabaseVar = { name: 'a', url: 'libsql://a', token: 't', readOnly: false };
    expect(isDatabaseVar(v)).toBe(true);
  });

  it('rejects a plain string', () => {
    expect(isDatabaseVar('plain-string')).toBe(false);
  });

  it('rejects a ConnectionVar (has key/proxyUrl/proxyToken, not name/url/token/readOnly)', () => {
    expect(isDatabaseVar({ key: 'k', proxyUrl: 'u', proxyToken: 't' })).toBe(false);
  });

  it('rejects an object missing readOnly', () => {
    expect(isDatabaseVar({ name: 'a', url: 'u', token: 't' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot redaction: marker literal is the exact protocol constant
// ---------------------------------------------------------------------------

describe('redactVarsForSnapshot: DatabaseVar → marker', () => {
  it('replaces a DatabaseVar with the exact {"__redactedDatabaseVar":true,"varName":...} literal', () => {
    const vars = {
      MYDB: { name: 'analytics', url: 'libsql://a', token: 'secret-jwt', readOnly: false } as DatabaseVar,
    };
    const redacted = redactVarsForSnapshot(vars);
    expect(redacted.MYDB).toEqual({ __redactedDatabaseVar: true, varName: 'MYDB' });
  });

  it('the redacted marker never carries the token (round-trip: token absent from the serialized snapshot)', () => {
    const secretToken = 'super-secret-jwt-xyz';
    const vars = {
      MYDB: { name: 'analytics', url: 'libsql://a', token: secretToken, readOnly: false } as DatabaseVar,
    };
    const redacted = redactVarsForSnapshot(vars);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(secretToken);
    expect(isRedactedDatabaseVarRef(redacted.MYDB)).toBe(true);
  });

  it('does not affect plain string vars or ConnectionVars', () => {
    const vars = {
      FLAG: 'on',
      GCAL: { key: 'k', proxyUrl: 'u', proxyToken: 't' },
    };
    const redacted = redactVarsForSnapshot(vars);
    expect(redacted.FLAG).toBe('on');
    expect(redacted.GCAL).toEqual({ __redactedConnectionVar: true, varName: 'GCAL', proxyUrl: 'u' });
  });
});

// ---------------------------------------------------------------------------
// Rehydration: FULL substitution from the CURRENT dispatch's live var
// ---------------------------------------------------------------------------

describe('rehydrateVarsFromSnapshot: DatabaseVar full substitution (spec §4A divergence)', () => {
  it('rehydrates the marker with the ENTIRE current live var (url/token/readOnly/name all live)', () => {
    const snapshot = { MYDB: { __redactedDatabaseVar: true, varName: 'MYDB' } };
    const liveVars = {
      MYDB: {
        name: 'analytics',
        url: 'libsql://NEW-hostname-after-restore.turso.io',
        token: 'fresh-jwt-this-dispatch',
        readOnly: true, // e.g. after a write-fuse trip
      } as DatabaseVar,
    };
    const rehydrated = rehydrateVarsFromSnapshot(snapshot, liveVars);
    expect(rehydrated.MYDB).toEqual(liveVars.MYDB);
  });

  it('a restore/fuse change between dispatches: rehydration reflects the CURRENT dispatch, not any stale snapshot data', () => {
    // Simulate dispatch #1's snapshot (only the marker is ever persisted —
    // there is nothing snapshot-preserved for DatabaseVar, unlike ConnectionVar's proxyUrl).
    const snapshotFromDispatch1 = { MYDB: { __redactedDatabaseVar: true, varName: 'MYDB' } };

    // Dispatch #2's live env: database was restored (new hostname) and the
    // workspace write fuse tripped (readOnly flipped true).
    const dispatch2LiveVars = {
      MYDB: {
        name: 'analytics',
        url: 'libsql://post-restore-hostname.turso.io',
        token: 'jwt-dispatch-2',
        readOnly: true,
      } as DatabaseVar,
    };

    const rehydrated = rehydrateVarsFromSnapshot(snapshotFromDispatch1, dispatch2LiveVars);
    expect(rehydrated.MYDB).toEqual(dispatch2LiveVars.MYDB);
    // In particular: neither url nor readOnly is pinned from any prior state.
    expect((rehydrated.MYDB as DatabaseVar).url).toBe('libsql://post-restore-hostname.turso.io');
    expect((rehydrated.MYDB as DatabaseVar).readOnly).toBe(true);
  });

  it('live var missing (mapping removed between dispatches) leaves the marker ref in place', () => {
    const snapshot = { MYDB: { __redactedDatabaseVar: true, varName: 'MYDB' } };
    const liveVars = {}; // mapping no longer present
    const rehydrated = rehydrateVarsFromSnapshot(snapshot, liveVars);
    expect(rehydrated.MYDB).toEqual({ __redactedDatabaseVar: true, varName: 'MYDB' });
  });

  it('live var present but wrong shape (e.g. now a plain string) also leaves the marker ref in place', () => {
    const snapshot = { MYDB: { __redactedDatabaseVar: true, varName: 'MYDB' } };
    const liveVars = { MYDB: 'not-a-database-var-anymore' };
    const rehydrated = rehydrateVarsFromSnapshot(snapshot, liveVars);
    expect(rehydrated.MYDB).toEqual({ __redactedDatabaseVar: true, varName: 'MYDB' });
  });

  it('a plain DatabaseVar entry (legacy/no marker) passes through unchanged', () => {
    const dbVar: DatabaseVar = { name: 'a', url: 'libsql://a', token: 't', readOnly: false };
    const rehydrated = rehydrateVarsFromSnapshot({ MYDB: dbVar }, {});
    expect(rehydrated.MYDB).toEqual(dbVar);
  });
});

// ---------------------------------------------------------------------------
// collectSecretStrings: the DatabaseVar token scrubs from step outputs/logs
// ---------------------------------------------------------------------------

describe('collectSecretStrings: DatabaseVar token', () => {
  it('includes the token of a DatabaseVar', () => {
    const vars = {
      MYDB: { name: 'a', url: 'libsql://a', token: 'jwt-to-scrub', readOnly: false } as DatabaseVar,
    };
    const secrets = collectSecretStrings(vars);
    expect(secrets).toContain('jwt-to-scrub');
  });

  it('collects both a ConnectionVar secret and a DatabaseVar token together', () => {
    const vars = {
      GCAL: { key: 'conn-key', proxyUrl: 'u', proxyToken: 'conn-proxy-tok' },
      MYDB: { name: 'a', url: 'libsql://a', token: 'db-tok', readOnly: false } as DatabaseVar,
    };
    const secrets = collectSecretStrings(vars);
    expect(secrets).toEqual(expect.arrayContaining(['conn-key', 'conn-proxy-tok', 'db-tok']));
  });

  it('does not include the token for an empty-string token', () => {
    const vars = {
      MYDB: { name: 'a', url: 'libsql://a', token: '', readOnly: false } as DatabaseVar,
    };
    expect(collectSecretStrings(vars)).toEqual([]);
  });
});
