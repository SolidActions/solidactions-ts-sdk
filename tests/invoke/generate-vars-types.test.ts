/**
 * Task 4.1 — generate-vars-types + declarations parser tests.
 *
 * TDD: written before the implementation; tests are the spec.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 * No mocks/spies/stubs/fakes per project testing rules.
 */

import { generateVarsTypes } from '../../src/invoke/generate-vars-types';
import { parseDeclarations } from '../../src/invoke/declarations';

// ---------------------------------------------------------------------------
// (a) Plain env declarations → `MY_FLAG: string` in the emitted .d.ts
// ---------------------------------------------------------------------------
it('(a) plain env declarations produce a string-typed property in the emitted d.ts', () => {
  const dts = generateVarsTypes({ vars: ['MY_FLAG'], connections: [] });

  expect(dts).toContain('MY_FLAG: string;');
  expect(dts).toContain('interface GeneratedVars');
});

// ---------------------------------------------------------------------------
// (b) Connection declarations → `GCAL: ConnectionVar` in the emitted .d.ts
// ---------------------------------------------------------------------------
it('(b) connection declarations produce a ConnectionVar-typed property in the emitted d.ts', () => {
  const dts = generateVarsTypes({ vars: [], connections: ['GCAL'] });

  expect(dts).toContain('GCAL: ConnectionVar;');
  expect(dts).toContain('interface GeneratedVars');
  // Must import ConnectionVar from the SDK since it is used in the output
  expect(dts).toContain("from '@solidactions/sdk'");
});

// ---------------------------------------------------------------------------
// (c) Mixed (env + connections) → both shapes present
// ---------------------------------------------------------------------------
it('(c) mixed env + connection declarations produce both shapes in the emitted d.ts', () => {
  const dts = generateVarsTypes({ vars: ['MY_FLAG'], connections: ['GCAL'] });

  expect(dts).toContain('MY_FLAG: string;');
  expect(dts).toContain('GCAL: ConnectionVar;');
  expect(dts).toContain('interface GeneratedVars');
  expect(dts).toContain("from '@solidactions/sdk'");
});

// ---------------------------------------------------------------------------
// (d) Empty declarations → syntactically-valid .d.ts with empty interface body
// ---------------------------------------------------------------------------
it('(d) empty declarations produce a syntactically-valid d.ts with no crash', () => {
  const dts = generateVarsTypes({ vars: [], connections: [] });

  expect(dts).toContain('interface GeneratedVars');
  // Must close the interface — no dangling open brace
  expect(dts).toContain('{}');
  // Must NOT produce a ConnectionVar import when there are none
  expect(dts).not.toContain('ConnectionVar');
});

// ---------------------------------------------------------------------------
// (e) Declarations parser handles the real solidactions.yaml shape
// ---------------------------------------------------------------------------
it('(e) parseDeclarations handles the real solidactions.yaml env shape', () => {
  // Mirror of the actual examples/sdk-test/solidactions.yaml env block.
  // Using an inline fixture so the test is hermetic (no cross-worktree fs reads).
  const yamlFixture = `
project: sdk-test

env:
  - TEST_ENV_VAR
  - MAPPED_SECRET: JIMBO
  - SOLIDACTIONS_TEST_SEED
  - SENDER_WEBHOOK_URL
  - SENDER_WEBHOOK_SECRET
  - GHOST_VAR: DOES_NOT_EXIST
  - GOOGLE_CALENDAR_TOKEN:
      oauth: "Google Calendar 1"
  - SLACK_TOKEN:
      oauth: "Slack Bot"
  - E2E_ENV_VAR: E2E_ENV_VAR
  - E2E_MAPPED_VAR: E2E_MAPPED_VAR
  - E2E_OVERRIDE_VAR: E2E_OVERRIDE_VAR
  - E2E_SNAPSHOT_MODE
  - E2E_PICA

workflows: []
`.trim();

  const decls = parseDeclarations(yamlFixture);

  // Plain string vars (declared only or mapped to globals)
  expect(decls.vars).toContain('TEST_ENV_VAR');
  expect(decls.vars).toContain('MAPPED_SECRET');
  expect(decls.vars).toContain('SOLIDACTIONS_TEST_SEED');
  expect(decls.vars).toContain('SENDER_WEBHOOK_URL');
  expect(decls.vars).toContain('SENDER_WEBHOOK_SECRET');
  expect(decls.vars).toContain('GHOST_VAR');
  expect(decls.vars).toContain('E2E_ENV_VAR');
  expect(decls.vars).toContain('E2E_MAPPED_VAR');
  expect(decls.vars).toContain('E2E_OVERRIDE_VAR');
  expect(decls.vars).toContain('E2E_SNAPSHOT_MODE');
  expect(decls.vars).toContain('E2E_PICA');

  // OAuth connection vars
  expect(decls.connections).toContain('GOOGLE_CALENDAR_TOKEN');
  expect(decls.connections).toContain('SLACK_TOKEN');

  // Connections must NOT appear in plain vars list
  expect(decls.vars).not.toContain('GOOGLE_CALENDAR_TOKEN');
  expect(decls.vars).not.toContain('SLACK_TOKEN');

  // No stray extra entries
  expect(decls.connections).toHaveLength(2);
  expect(decls.vars).toHaveLength(11);
});

// ---------------------------------------------------------------------------
// (f) Generated output contains the SDK-generated banner
// ---------------------------------------------------------------------------
it('(f) generated d.ts contains a DO NOT EDIT banner', () => {
  const dts = generateVarsTypes({ vars: ['X'], connections: [] });

  expect(dts).toContain('DO NOT EDIT');
});

// ---------------------------------------------------------------------------
// Additional: augmentation module declaration is present in all non-empty outputs
// ---------------------------------------------------------------------------
it('augmentation declare module block targets @solidactions/sdk', () => {
  const dts = generateVarsTypes({ vars: ['FOO'], connections: ['BAR'] });

  expect(dts).toContain("declare module '@solidactions/sdk'");
  expect(dts).toContain('interface InvokeCtxVarsAugment extends GeneratedVars');
});

// ---------------------------------------------------------------------------
// Additional: parseDeclarations handles yaml with no env key gracefully
// ---------------------------------------------------------------------------
it('parseDeclarations returns empty result for yaml without an env key', () => {
  const yaml = `project: empty\nworkflows: []`;
  const decls = parseDeclarations(yaml);

  expect(decls.vars).toEqual([]);
  expect(decls.connections).toEqual([]);
});

// ---------------------------------------------------------------------------
// Additional: parseDeclarations handles an empty yaml document
// ---------------------------------------------------------------------------
it('parseDeclarations returns empty result for an empty yaml string', () => {
  const decls = parseDeclarations('');

  expect(decls.vars).toEqual([]);
  expect(decls.connections).toEqual([]);
});

// ---------------------------------------------------------------------------
// Additional: round-trip — parse then generate produces a .d.ts with all names
// ---------------------------------------------------------------------------
it('round-trip: parse yaml then generate emits all names in the d.ts', () => {
  const yaml = `
env:
  - PLAIN_VAR
  - MY_CONNECTION:
      oauth: "Some Service"
`.trim();

  const decls = parseDeclarations(yaml);
  const dts = generateVarsTypes(decls);

  expect(dts).toContain('PLAIN_VAR: string;');
  expect(dts).toContain('MY_CONNECTION: ConnectionVar;');
});
