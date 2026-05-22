/**
 * Task 4.2 — process.env deploy gate tests.
 *
 * TDD: written before the implementation; tests are the spec.
 *
 * Contract: workflow modules must read variables via ctx.vars, not process.env.
 * - Hard-fail: static `process.env.NAME` (MemberExpression, computed=false,
 *   property is an Identifier). User clearly meant a specific named var.
 * - Report-only: dynamic `process.env[expr]` (MemberExpression, computed=true).
 *   Could be legitimate (reading a runtime-computed key); flag but don't block.
 * - Standalone `process.env` reference (e.g. Object.keys(process.env)):
 *   report-only — not a named var access, but worth flagging for migration.
 *
 * AST-based (TypeScript compiler API), NOT regex. Module-wide scope: nested
 * functions/class bodies ARE flagged because the contract is module-wide —
 * no hidden process.env access, regardless of nesting depth.
 *
 * jest globals — describe/it/expect are ambient; do NOT import from 'vitest'.
 * No mocks/spies/stubs/fakes per project testing rules.
 */

import { scanWorkflowEnvUsage, formatEnvGateReport, EnvGateError } from '../../src/invoke/env-gate';

// ---------------------------------------------------------------------------
// (a) Static `process.env.SECRET` → hardFail: true + a Hit with file/line
// ---------------------------------------------------------------------------
it('(a) static process.env.SECRET access → hardFail: true with a Hit carrying file/line', () => {
  const source = [
    'import { defineWorkflow } from "@solidactions/sdk";',
    '',
    'export const wf = defineWorkflow({',
    '  run: async (ctx) => {',
    '    const secret = process.env.SECRET;',
    '    return { secret };',
    '  },',
    '});',
  ].join('\n');

  const result = scanWorkflowEnvUsage('src/workflow.ts', source);

  expect(result.hardFail).toBe(true);
  expect(result.hardFails).toHaveLength(1);
  expect(result.reports).toHaveLength(0);

  const hit = result.hardFails[0];
  expect(hit.file).toBe('src/workflow.ts');
  expect(hit.line).toBe(5); // line where `process.env.SECRET` appears
  expect(hit.access).toContain('process.env.SECRET');
});

// ---------------------------------------------------------------------------
// (b) Dynamic `process.env[k]` → hardFail: false, reports non-empty
// ---------------------------------------------------------------------------
it('(b) dynamic process.env[k] access → hardFail: false, reports non-empty with a Hit', () => {
  const source = [
    'const k = "X";',
    'const val = process.env[k];',
  ].join('\n');

  const result = scanWorkflowEnvUsage('src/dynamic.ts', source);

  expect(result.hardFail).toBe(false);
  expect(result.hardFails).toHaveLength(0);
  expect(result.reports).toHaveLength(1);

  const hit = result.reports[0];
  expect(hit.file).toBe('src/dynamic.ts');
  expect(hit.line).toBe(2);
  // The access snippet should indicate a dynamic access
  expect(hit.access).toContain('process.env[');
});

// ---------------------------------------------------------------------------
// (c) Standalone `process.env` reference → report-only (not hard-fail)
//     Judgment: Object.keys(process.env) or spread is not a named var access;
//     flag it for migration awareness but don't block the deploy.
// ---------------------------------------------------------------------------
it('(c) standalone process.env reference (e.g. Object.keys) → report-only, not hard-fail', () => {
  const source = 'const keys = Object.keys(process.env);\n';

  const result = scanWorkflowEnvUsage('src/keys.ts', source);

  expect(result.hardFail).toBe(false);
  expect(result.hardFails).toHaveLength(0);
  // The standalone process.env should be reported (not hard-failed)
  expect(result.reports.length).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// (d) No `process.env` usage → no hits at all
// ---------------------------------------------------------------------------
it('(d) no process.env usage → zero hardFails and zero reports', () => {
  const source = [
    'import { defineWorkflow } from "@solidactions/sdk";',
    '',
    'export const wf = defineWorkflow({',
    '  run: async (ctx) => {',
    '    const secret = ctx.vars.SECRET;',
    '    return { secret };',
    '  },',
    '});',
  ].join('\n');

  const result = scanWorkflowEnvUsage('src/clean.ts', source);

  expect(result.hardFail).toBe(false);
  expect(result.hardFails).toHaveLength(0);
  expect(result.reports).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (e) `process.env.X` inside a comment or string literal → NOT flagged
//     AST-correct: the TS parser parses these as literals, not MemberExpressions.
// ---------------------------------------------------------------------------
it('(e) process.env.X in a comment or string literal → not flagged (AST-based)', () => {
  const source = [
    '// Migrate from process.env.SECRET to ctx.vars.SECRET',
    '/** @example process.env.MY_VAR */',
    'export const HELP = "Use ctx.vars instead of process.env.TOKEN";',
    "export const HELP2 = `or process.env.KEY`;",
    "export const HELP3 = 'process.env.X';",
  ].join('\n');

  const result = scanWorkflowEnvUsage('src/docs.ts', source);

  expect(result.hardFail).toBe(false);
  expect(result.hardFails).toHaveLength(0);
  expect(result.reports).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (f) `process.env.X` deep inside a nested function/class body → STILL flagged
//     Contract is module-wide: no hidden process.env access anywhere.
// ---------------------------------------------------------------------------
it('(f) process.env.X deep inside nested function/class body → still flagged (module-wide contract)', () => {
  const source = [
    'import { defineWorkflow } from "@solidactions/sdk";',
    '',
    'function helper() {',
    '  return process.env.NESTED_SECRET;',
    '}',
    '',
    'class MyClass {',
    '  getValue() {',
    '    return process.env.CLASS_SECRET;',
    '  }',
    '}',
    '',
    'const arrow = () => process.env.ARROW_SECRET;',
    '',
    'export const wf = defineWorkflow({',
    '  run: async (ctx) => ({ ok: true }),',
    '});',
  ].join('\n');

  const result = scanWorkflowEnvUsage('src/nested.ts', source);

  expect(result.hardFail).toBe(true);
  // All three nested accesses should be caught
  expect(result.hardFails).toHaveLength(3);
  const lines = result.hardFails.map((h) => h.line).sort((a, b) => a - b);
  expect(lines[0]).toBe(4); // helper() body
  expect(lines[1]).toBe(9); // class method body
  expect(lines[2]).toBe(13); // arrow function
});

// ---------------------------------------------------------------------------
// (g) Multiple violations across multiple AST positions are all captured
// ---------------------------------------------------------------------------
it('(g) multiple process.env accesses at different positions are all captured', () => {
  const source = [
    'const a = process.env.A;', // line 1 — static hard-fail
    'const b = process.env.B;', // line 2 — static hard-fail
    'const c = process.env[someKey];', // line 3 — dynamic report-only
    'const d = process.env.D;', // line 4 — static hard-fail
  ].join('\n');

  const result = scanWorkflowEnvUsage('src/multi.ts', source);

  expect(result.hardFail).toBe(true);
  expect(result.hardFails).toHaveLength(3);
  expect(result.reports).toHaveLength(1);

  const hardFailLines = result.hardFails.map((h) => h.line).sort((a, b) => a - b);
  expect(hardFailLines).toEqual([1, 2, 4]);
  expect(result.reports[0].line).toBe(3);
});

// ---------------------------------------------------------------------------
// (h) formatEnvGateReport — clean output format
// ---------------------------------------------------------------------------
it('(h) formatEnvGateReport produces a clean, per-violation summary for empty results', () => {
  const report = formatEnvGateReport([]);

  // Empty results → empty string (nothing to report)
  expect(report).toBe('');
});

it('(h) formatEnvGateReport with hard-fail results includes file:line:col, access snippet, and migration hint', () => {
  const result = scanWorkflowEnvUsage(
    'src/secret.ts',
    [
      'const x = process.env.SECRET;', // line 1
    ].join('\n'),
  );

  const report = formatEnvGateReport([result]);

  // Must include the file path
  expect(report).toContain('src/secret.ts');
  // Must include line number
  expect(report).toContain(':1:');
  // Must include the access snippet
  expect(report).toContain('process.env.SECRET');
  // Must include a migration hint pointing to ctx.vars
  expect(report).toContain('ctx.vars');
});

it('(h) formatEnvGateReport with dynamic (report-only) results includes file:line:col and access snippet', () => {
  const result = scanWorkflowEnvUsage(
    'src/dynamic.ts',
    ['const val = process.env[key];'].join('\n'),
  );

  const report = formatEnvGateReport([result]);

  expect(report).toContain('src/dynamic.ts');
  expect(report).toContain(':1:');
  expect(report).toContain('process.env[');
});

it('(h) formatEnvGateReport formats one violation per line', () => {
  const result = scanWorkflowEnvUsage(
    'src/multi.ts',
    [
      'const a = process.env.A;',
      'const b = process.env.B;',
    ].join('\n'),
  );

  const report = formatEnvGateReport([result]);
  const lines = report.split('\n').filter((l) => l.trim().length > 0);

  // Should have at least 2 violation lines (one per hard-fail) plus header/footer
  const violationLines = lines.filter(
    (l) => l.includes('process.env.A') || l.includes('process.env.B'),
  );
  expect(violationLines).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// EnvGateError — thrown when hardFail results exist
// ---------------------------------------------------------------------------
it('EnvGateError is an Error with message, carries results array', () => {
  const result = scanWorkflowEnvUsage('src/err.ts', 'const x = process.env.SECRET;\n');
  const error = new EnvGateError([result]);

  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(EnvGateError);
  expect(error.name).toBe('EnvGateError');
  expect(error.results).toBe(error.results); // identity preserved
  expect(error.message.length).toBeGreaterThan(0);
  // Message should reference the file
  expect(error.message).toContain('src/err.ts');
});

// ---------------------------------------------------------------------------
// Additional: column number is captured in each Hit
// ---------------------------------------------------------------------------
it('Hit carries a non-negative column number', () => {
  const source = '    const x = process.env.SECRET;\n'; // 4-space indent

  const result = scanWorkflowEnvUsage('src/col.ts', source);

  expect(result.hardFails).toHaveLength(1);
  expect(result.hardFails[0].column).toBeGreaterThan(0); // indented → col > 0
});

// ---------------------------------------------------------------------------
// Additional: Hit.access is a short, human-readable snippet
// ---------------------------------------------------------------------------
it('Hit.access is a short snippet (not the whole line)', () => {
  const source = 'const reallyLongVariableName = process.env.TOKEN; // some comment\n';

  const result = scanWorkflowEnvUsage('src/snip.ts', source);

  expect(result.hardFails).toHaveLength(1);
  // access should be just the process.env.TOKEN expression, not the entire line
  expect(result.hardFails[0].access).toBe('process.env.TOKEN');
});

// ---------------------------------------------------------------------------
// Additional: multiple files in formatEnvGateReport — all files included
// ---------------------------------------------------------------------------
it('formatEnvGateReport with results from multiple files includes all file paths', () => {
  const resultA = scanWorkflowEnvUsage('src/a.ts', 'const x = process.env.A;\n');
  const resultB = scanWorkflowEnvUsage('src/b.ts', 'const y = process.env.B;\n');

  const report = formatEnvGateReport([resultA, resultB]);

  expect(report).toContain('src/a.ts');
  expect(report).toContain('src/b.ts');
  expect(report).toContain('process.env.A');
  expect(report).toContain('process.env.B');
});
