/**
 * Task 6.2 — migration codemod tests.
 *
 * TDD: written before the implementation; tests are the spec.
 *
 * The codemod helps users move OLD workflow source to the NEW ctx-based
 * contract. It AUTOFIXES the safe, mechanical cases (registerWorkflow →
 * defineWorkflow, static process.env.X inside a run fn → ctx.vars.X) and
 * REPORTS (does not rewrite) the risky ones (dynamic env access, module
 * top-level env access, spreads, connection-fetch patterns, Composio).
 *
 * AST-based (TypeScript compiler API), NOT regex — same discipline as
 * env-gate.ts and selfInvokeGate.ts: process.env / registerWorkflow tokens
 * inside comments and string literals must NOT be rewritten or reported.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 * No mocks/spies/stubs/fakes per project testing rules.
 */

import { codemod } from '../../src/migrate/codemod';

// ===========================================================================
// PLAN CASES (verbatim intent, plan lines 717-730)
// ===========================================================================

it('(plan-1) rewrites process.env.NAME → ctx.vars.NAME and registerWorkflow → defineWorkflow', () => {
  const out = codemod(`const wf = SolidActions.registerWorkflow(async () => process.env.API_URL);`);
  expect(out.code).toContain('defineWorkflow(');
  expect(out.code).toContain('ctx.vars.API_URL');
});

it('(plan-2) reports (does not rewrite) dynamic env access', () => {
  const out = codemod(`const k='X'; export default { run(){ return process.env[k]; } }`);
  expect(out.reports[0]).toMatch(/dynamic process\.env/);
  expect(out.code).not.toContain('ctx.vars[');
});

it('(plan-3) flags Composio-broker connections as deprecated, does not crash', () => {
  const out = codemod(`/* composio */`, { connections: [{ name: 'X', broker: 'composio' }] });
  expect(out.reports.join()).toMatch(/Composio.*deprecated/i);
});

// ===========================================================================
// AUTOFIX — registerWorkflow → defineWorkflow({ run })
// ===========================================================================

it('rewrites SolidActions.registerWorkflow(arrow) → defineWorkflow({ run: arrow })', () => {
  const out = codemod(`const wf = SolidActions.registerWorkflow(async (ctx) => ctx.input);`);
  expect(out.code).toContain('defineWorkflow(');
  expect(out.code).toContain('run:');
  // The arrow body is preserved
  expect(out.code).toContain('ctx.input');
  // registerWorkflow is gone from the output
  expect(out.code).not.toContain('registerWorkflow');
});

it('rewrites a bare (imported) registerWorkflow(fn) → defineWorkflow({ run: fn })', () => {
  const out = codemod(
    [
      `import { registerWorkflow } from "@solidactions/sdk";`,
      `const wf = registerWorkflow(async (ctx) => ctx.input);`,
    ].join('\n'),
  );
  expect(out.code).toContain('defineWorkflow(');
  expect(out.code).toContain('run:');
  // The call-site registerWorkflow is rewritten (the import is left to the user;
  // only the *call* is structurally rewritten).
  expect(out.code).toContain('defineWorkflow(');
});

it('rewrites registerWorkflow with a NAMED function expression → defineWorkflow({ run: async function foo() {...} })', () => {
  const out = codemod(`const wf = registerWorkflow(async function foo(ctx) { return ctx.input; });`);
  expect(out.code).toContain('defineWorkflow(');
  expect(out.code).toContain('run:');
  expect(out.code).toContain('function foo');
  expect(out.code).not.toContain('registerWorkflow');
});

// ===========================================================================
// AUTOFIX — process.env.X inside a workflow run fn → ctx.vars.X
// ===========================================================================

it('injects a ctx param when the run fn has none, and rewrites process.env.X → ctx.vars.X', () => {
  const out = codemod(`const wf = SolidActions.registerWorkflow(async () => process.env.API_URL);`);
  expect(out.code).toContain('defineWorkflow(');
  expect(out.code).toContain('ctx.vars.API_URL');
  // The injected param must be present so the output is valid (ctx is in scope).
  expect(out.code).toMatch(/async \(?ctx\)?\s*=>/);
  // process.env must be fully gone from the rewritten body.
  expect(out.code).not.toContain('process.env');
});

it('reuses an existing first param named ctx (does NOT double-inject)', () => {
  const out = codemod(`const wf = registerWorkflow(async (ctx) => process.env.X);`);
  expect(out.code).toContain('ctx.vars.X');
  // Only one `ctx` param — no `(ctx, ctx)` double injection.
  expect(out.code).not.toMatch(/\(\s*ctx\s*,\s*ctx\s*\)/);
  expect(out.code).not.toContain('process.env');
});

it('reuses a differently-named first param (async (c) => process.env.X → c.vars.X)', () => {
  const out = codemod(`const wf = registerWorkflow(async (c) => process.env.X);`);
  // The rewrite reuses the existing param name `c`, not the convention `ctx`.
  expect(out.code).toContain('c.vars.X');
  expect(out.code).not.toContain('ctx.vars.X');
  expect(out.code).not.toContain('process.env');
});

it('rewrites multiple static process.env.X accesses inside one run fn', () => {
  const out = codemod(
    `const wf = registerWorkflow(async (ctx) => { const a = process.env.A; const b = process.env.B; return a + b; });`,
  );
  expect(out.code).toContain('ctx.vars.A');
  expect(out.code).toContain('ctx.vars.B');
  expect(out.code).not.toContain('process.env');
});

// ===========================================================================
// REPORT-ONLY — dynamic / module-top-level / spread
// ===========================================================================

it('reports dynamic process.env[expr] inside a run fn, does NOT rewrite to ctx.vars[...]', () => {
  const out = codemod(`const wf = registerWorkflow(async (ctx) => process.env[ctx.input.key]);`);
  expect(out.reports.some((r) => /dynamic process\.env/.test(r))).toBe(true);
  expect(out.code).not.toContain('ctx.vars[');
});

it('reports module-top-level process.env.X (no enclosing run fn) and does NOT rewrite it', () => {
  const out = codemod(
    [
      `const TOP = process.env.TOP_LEVEL;`,
      `const wf = registerWorkflow(async (ctx) => TOP);`,
    ].join('\n'),
  );
  // Module-top-level access cannot become ctx.vars.* (ctx isn't in scope there).
  const topReport = out.reports.find((r) => /TOP_LEVEL/.test(r));
  expect(topReport).toBeDefined();
  expect(topReport).toMatch(/run\(\)/); // guidance points at the run() body
  // The top-level access is left verbatim — rewriting it would be a ReferenceError.
  expect(out.code).toContain('process.env.TOP_LEVEL');
});

it('reports spread of process.env ({...process.env}) and does NOT rewrite it', () => {
  const out = codemod(`const all = { ...process.env };`);
  expect(out.reports.some((r) => /process\.env/.test(r))).toBe(true);
  // Spread is left intact.
  expect(out.code).toContain('...process.env');
});

it('both fire: process.env.X autofixed inside a run fn AND reported at module top-level', () => {
  const out = codemod(
    [
      `const TOP = process.env.TOP_ONLY;`,
      `const wf = registerWorkflow(async (ctx) => process.env.IN_BODY);`,
    ].join('\n'),
  );
  // Inside the run fn → autofixed.
  expect(out.code).toContain('ctx.vars.IN_BODY');
  // Module top-level → reported, not rewritten.
  expect(out.code).toContain('process.env.TOP_ONLY');
  expect(out.reports.some((r) => /TOP_ONLY/.test(r))).toBe(true);
});

// ===========================================================================
// REPORT-ONLY — connection-fetch pattern (Composio-style getConnection)
// ===========================================================================

it('reports the old connection-fetch pattern (getConnection) WITH guidance, does NOT auto-rewrite', () => {
  const out = codemod(
    `const wf = registerWorkflow(async (ctx) => { const conn = await getConnection("gcal"); return conn; });`,
  );
  expect(out.reports.some((r) => /getConnection/.test(r))).toBe(true);
  // The connection-fetch call is left in place (report-only with guidance).
  expect(out.code).toContain('getConnection');
});

// ===========================================================================
// AST CORRECTNESS — comments / strings must NOT be touched
// ===========================================================================

it('does NOT touch process.env or registerWorkflow inside comments or string literals', () => {
  const source = [
    `// Migrate from process.env.SECRET to ctx.vars.SECRET`,
    `/** @example SolidActions.registerWorkflow(fn) */`,
    `export const HELP = "Use ctx.vars instead of process.env.TOKEN";`,
    'export const HELP2 = `or registerWorkflow(x)`;',
  ].join('\n');

  const out = codemod(source);

  // No rewrites happened — the source is structurally unchanged in intent.
  expect(out.code).toContain('process.env.SECRET'); // still in the comment
  expect(out.code).toContain('process.env.TOKEN'); // still in the string
  expect(out.code).toContain('registerWorkflow(fn)'); // still in the comment
  // No spurious reports for comment/string mentions.
  expect(out.reports).toHaveLength(0);
});

// ===========================================================================
// NO-OP — nothing to do
// ===========================================================================

it('returns code unchanged and reports empty when there is nothing to migrate', () => {
  const source = [
    `import { defineWorkflow } from "@solidactions/sdk";`,
    `export const wf = defineWorkflow({`,
    `  run: async (ctx) => ctx.vars.SECRET,`,
    `});`,
  ].join('\n');

  const out = codemod(source);

  expect(out.code).toBe(source);
  expect(out.reports).toHaveLength(0);
});

it('handles empty / comment-only source gracefully', () => {
  expect(() => codemod('')).not.toThrow();
  expect(() => codemod('/* composio */')).not.toThrow();
  const out = codemod('');
  expect(out.reports).toHaveLength(0);
});

// ===========================================================================
// COMPOSIO DEPRECATION — only fires for broker: 'composio'
// ===========================================================================

it('does NOT emit a Composio deprecation report for a non-composio broker', () => {
  const out = codemod(`/* x */`, { connections: [{ name: 'GCAL', broker: 'pica' }] });
  expect(out.reports.join()).not.toMatch(/Composio.*deprecated/i);
});

it('emits a Composio deprecation report per composio connection', () => {
  const out = codemod(`/* x */`, {
    connections: [
      { name: 'A', broker: 'composio' },
      { name: 'B', broker: 'pica' },
      { name: 'C', broker: 'composio' },
    ],
  });
  const composioReports = out.reports.filter((r) => /Composio.*deprecated/i.test(r));
  expect(composioReports.length).toBeGreaterThanOrEqual(1);
  // The named connections appear in the deprecation guidance.
  expect(out.reports.join()).toContain('A');
  expect(out.reports.join()).toContain('C');
});
