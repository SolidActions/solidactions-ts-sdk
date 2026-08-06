/**
 * Task 4.1 — Parse `solidactions.yaml` env/connection declarations.
 *
 * Reads the top-level `env:` list from a solidactions.yaml project file and
 * classifies each entry as either a plain env var or an OAuth connection var.
 *
 * The solidactions.yaml `env:` list accepts three item shapes:
 *
 *   - `- VAR_NAME`                          plain string, declared only
 *   - `- VAR_NAME: GLOBAL_NAME`             mapped to a global variable (still plain string)
 *   - `- VAR_NAME:\n    oauth: "Name"`      OAuth connection mapping → ConnectionVar at runtime
 *   - `- VAR_NAME:\n    database: "Name"`   workspace database mapping → DatabaseVar at runtime (#1127)
 *
 * This module does NOT parse the full yaml schema — it only extracts the
 * information needed to type-generate `ctx.vars`. No new yaml keys are invented;
 * the parser tolerates unknown keys on each entry object (future-compat).
 */

import { parse } from 'yaml';

/** Parsed representation of all env declarations in a solidactions.yaml file. */
export interface VarsDeclarations {
  /** Names of plain env vars (string at runtime). */
  vars: string[];
  /** Names of OAuth connection vars (ConnectionVar at runtime). */
  connections: string[];
  /**
   * Names of workspace database vars (DatabaseVar at runtime; issue #1127).
   * Optional so existing hand-constructed `VarsDeclarations` literals (e.g.
   * pre-#1127 tests/callers) remain valid without a `databases` field.
   */
  databases?: string[];
}

/**
 * Parse a solidactions.yaml string and extract env declarations.
 *
 * Returns `{ vars: [], connections: [], databases: [] }` for any yaml that has
 * no `env:` key or an empty/non-array `env:` value — safe to call on any yaml
 * without crashing or throwing (except for invalid yaml syntax, which is
 * bubbled up).
 */
export function parseDeclarations(yamlContent: string): VarsDeclarations {
  const doc = parse(yamlContent) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') {
    return { vars: [], connections: [], databases: [] };
  }

  const env = doc['env'];
  if (!Array.isArray(env)) {
    return { vars: [], connections: [], databases: [] };
  }

  const vars: string[] = [];
  const connections: string[] = [];
  const databases: string[] = [];

  for (const item of env) {
    if (typeof item === 'string') {
      // Shape: `- VAR_NAME` (plain declaration)
      vars.push(item);
    } else if (item !== null && typeof item === 'object') {
      // Shape: `- VAR_NAME: GLOBAL_NAME`, `- VAR_NAME: { oauth: "..." }`, or
      // `- VAR_NAME: { database: "..." }`. In yaml, these parse to objects
      // with exactly one key: the var name.
      const keys = Object.keys(item as Record<string, unknown>);
      if (keys.length !== 1) {
        // Malformed or unknown shape — skip gracefully.
        continue;
      }
      const varName = keys[0];
      const value = (item as Record<string, unknown>)[varName];

      if (value !== null && typeof value === 'object' && typeof (value as { oauth?: unknown }).oauth === 'string') {
        // `{ oauth: "Connection Name" }` → ConnectionVar at runtime
        connections.push(varName);
      } else if (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { database?: unknown }).database === 'string'
      ) {
        // `{ database: "Database Name" }` → DatabaseVar at runtime (#1127)
        databases.push(varName);
      } else {
        // `GLOBAL_NAME` (string) or any other mapping → plain string var
        vars.push(varName);
      }
    }
    // null items or other primitives are skipped
  }

  return { vars, connections, databases };
}
