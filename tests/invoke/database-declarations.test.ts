/**
 * Issue #1127 — `declarations.ts` parses the `database:` YAML form and
 * `generate-vars-types.ts` emits `DatabaseVar` for those keys (spec §4B
 * item 5). Mirrors the existing OAuth-connection declaration/typegen tests.
 *
 * TDD: written before the implementation; tests are the spec.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 * No mocks/spies/stubs/fakes per project testing rules.
 */
import { parseDeclarations } from '../../src/invoke/declarations';
import { generateVarsTypes } from '../../src/invoke/generate-vars-types';

describe('parseDeclarations: database form', () => {
  it('a `- VAR_NAME:\\n    database: "Name"` entry classifies as a database declaration', () => {
    const yaml = `
env:
  - MYDB:
      database: "analytics"
`.trim();
    const decls = parseDeclarations(yaml);
    expect(decls.databases).toEqual(['MYDB']);
    expect(decls.vars).not.toContain('MYDB');
    expect(decls.connections).not.toContain('MYDB');
  });

  it('mixed plain / oauth / database declarations classify independently', () => {
    const yaml = `
env:
  - PLAIN_VAR
  - GCAL:
      oauth: "Google Calendar"
  - MYDB:
      database: "analytics"
  - SECONDDB:
      database: "orders"
`.trim();
    const decls = parseDeclarations(yaml);
    expect(decls.vars).toEqual(['PLAIN_VAR']);
    expect(decls.connections).toEqual(['GCAL']);
    expect(decls.databases).toEqual(['MYDB', 'SECONDDB']);
  });

  it('yaml with no database declarations returns an empty databases list', () => {
    const yaml = `
env:
  - PLAIN_VAR
`.trim();
    const decls = parseDeclarations(yaml);
    expect(decls.databases).toEqual([]);
  });
});

describe('generateVarsTypes: database form', () => {
  it('emits the cross-kind database union for a database declaration', () => {
    const dts = generateVarsTypes({ vars: [], connections: [], databases: ['MYDB'] });
    expect(dts).toContain('MYDB: DatabaseVar | AnalyticalDatabaseBinding;');
    expect(dts).toContain('interface GeneratedVars');
  });

  it('imports DatabaseVar from @solidactions/sdk when a database declaration is present', () => {
    const dts = generateVarsTypes({ vars: [], connections: [], databases: ['MYDB'] });
    expect(dts).toContain("import type { DatabaseVar, AnalyticalDatabaseBinding } from '@solidactions/sdk'");
  });

  it('imports both ConnectionVar and DatabaseVar when both kinds are present', () => {
    const dts = generateVarsTypes({ vars: [], connections: ['GCAL'], databases: ['MYDB'] });
    expect(dts).toContain('ConnectionVar');
    expect(dts).toContain('DatabaseVar');
    expect(dts).toContain("from '@solidactions/sdk'");
  });

  it('does not import DatabaseVar when there are no database declarations', () => {
    const dts = generateVarsTypes({ vars: ['X'], connections: [], databases: [] });
    expect(dts).not.toContain('DatabaseVar');
  });

  it('omitting `databases` entirely (pre-#1127 caller) still produces a valid d.ts with no DatabaseVar', () => {
    const dts = generateVarsTypes({ vars: ['X'], connections: [] });
    expect(dts).toContain('X: string;');
    expect(dts).not.toContain('DatabaseVar');
  });

  it('round-trip: parse yaml with a database declaration then generate emits DatabaseVar', () => {
    const yaml = `
env:
  - PLAIN_VAR
  - MYDB:
      database: "analytics"
`.trim();
    const decls = parseDeclarations(yaml);
    const dts = generateVarsTypes(decls);
    expect(dts).toContain('PLAIN_VAR: string;');
    expect(dts).toContain('MYDB: DatabaseVar | AnalyticalDatabaseBinding;');
  });
});
