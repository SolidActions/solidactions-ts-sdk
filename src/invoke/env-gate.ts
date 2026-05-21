/**
 * Task 4.2 — process.env deploy gate scoped to workflow module graph.
 *
 * The new contract: workflows read variables via `ctx.vars`; `process.env`
 * access is deprecated for workflow modules.
 *
 * Two patterns are distinguished:
 *
 *   Hard-fail:   static `process.env.NAME`  (MemberExpression, computed=false,
 *                property is an Identifier). The user clearly meant a specific
 *                named var and should migrate to `ctx.vars.NAME`.
 *
 *   Report-only: dynamic `process.env[expr]` (MemberExpression, computed=true).
 *                Could be legitimate (reading a runtime-computed key); report
 *                with the location so the user can migrate manually, but don't
 *                block the deploy.
 *
 *   Standalone `process.env` (e.g. Object.keys(process.env)): report-only.
 *                Not a named-var access; flag for migration awareness but
 *                don't block.
 *
 * ## Scope
 *
 * Unlike `selfInvokeGate.ts` which only walks top-level statements (because
 * function-body calls don't fire at module-load), the env-gate is MODULE-WIDE:
 * it recursively walks all AST nodes, including nested function/method/class
 * bodies. The contract is "no process.env access anywhere in a workflow module"
 * — hidden accesses inside helpers are just as forbidden.
 *
 * ## Why AST and not regex?
 *
 * Regex would falsely flag `process.env.X` inside comments and string literals.
 * The TypeScript compiler API parses the file into an AST where comments and
 * string literal contents are distinct node kinds from MemberExpression nodes,
 * so we only visit genuine code accesses.
 *
 * ## Call site
 *
 * The gate is designed to be called at deploy/build time on each file in the
 * workflow module graph (the entrypoint + all user-owned imports under src/).
 * Wiring into the pipeline (e.g. configSync.ts) is a separate integration step
 * (Phase 7 / migration runbook). This module provides the analyzer so it is
 * ready to wire.
 */

import * as ts from 'typescript';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single `process.env` access detected in a workflow module source file.
 *
 * `access` is a short, human-readable snippet of the detected expression
 * (e.g. `process.env.SECRET` or `process.env[k]`) — NOT the whole source line.
 * Suitable for surfacing in build logs without overwhelming context.
 */
export interface Hit {
  /** The file argument passed to `scanWorkflowEnvUsage`. */
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** 0-indexed column number. */
  column: number;
  /** Short expression snippet: `process.env.NAME` or `process.env[<expr>]`. */
  access: string;
}

/**
 * Result of scanning a single workflow source file for `process.env` access.
 *
 * `hardFail` is true when at least one static `process.env.NAME` access was
 * found; those must be migrated to `ctx.vars.NAME` before the deploy succeeds.
 * `reports` contains dynamic / standalone accesses that should be reviewed.
 */
export interface EnvScanResult {
  hardFail: boolean;
  hardFails: Hit[];
  reports: Hit[];
}

/**
 * Thrown when `hardFail` results exist — callers that want a single throw
 * point can wrap `formatEnvGateReport` + `EnvGateError` together.
 */
export class EnvGateError extends Error {
  constructor(public readonly results: EnvScanResult[]) {
    super(formatEnvGateReport(results));
    this.name = 'EnvGateError';
  }
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/**
 * Pick a `ts.ScriptKind` from a file extension. `.mjs`/`.cjs` are treated as
 * JavaScript (same grammar; module-resolution differences don't affect parsing).
 */
function scriptKindFromExt(filename: string): ts.ScriptKind {
  const ext = filename.slice(filename.lastIndexOf('.'));
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

/**
 * Return a compact snippet string for a `process.env` MemberExpression node.
 *
 *   process.env.SECRET   → 'process.env.SECRET'
 *   process.env[k]       → 'process.env[k]'
 *   process.env          → 'process.env'   (standalone)
 */
function buildAccessSnippet(node: ts.MemberExpression | ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.Node): string {
  // We receive the `process.env.*` outer node (if it is a member access on
  // `process.env`) or the `process.env` node itself.
  if (ts.isPropertyAccessExpression(node)) {
    // static: process.env.NAME
    return `process.env.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node)) {
    // dynamic: process.env[<expr>]
    const argText = node.argumentExpression.getText();
    return `process.env[${argText}]`;
  }
  // standalone `process.env` reference
  return 'process.env';
}

/**
 * Is `node` exactly the `process.env` MemberExpression
 * (i.e. `process` dot-access `env`, not computed)?
 */
function isProcessEnv(node: ts.Node): node is ts.PropertyAccessExpression {
  if (!ts.isPropertyAccessExpression(node)) return false;
  const obj = node.expression;
  return ts.isIdentifier(obj) && obj.text === 'process' && node.name.text === 'env';
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan a single workflow source file for `process.env` accesses.
 *
 * The scan is MODULE-WIDE: it descends into every function, method, class, and
 * nested scope. The workflow module contract forbids `process.env` anywhere.
 *
 * @param filename - The logical filename (used in `Hit.file` and for script-kind
 *                   detection; does NOT need to exist on disk).
 * @param source   - The UTF-8 source text to scan.
 */
export function scanWorkflowEnvUsage(filename: string, source: string): EnvScanResult {
  const hardFails: Hit[] = [];
  const reports: Hit[] = [];

  // Fast pre-filter: if the source doesn't contain "process.env" at all, skip
  // the AST parse entirely (performance optimization; correctness-preserving
  // because the AST walker also requires the exact node shape to match).
  if (!source.includes('process.env')) {
    return { hardFail: false, hardFails, reports };
  }

  const scriptKind = scriptKindFromExt(filename);
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind);

  /**
   * Recursive module-wide visitor. Descends into ALL child nodes — there is no
   * scope boundary we stop at. Every `process.env.*` access, regardless of
   * nesting depth, is flagged.
   */
  function visit(node: ts.Node): void {
    // Check if this node is `process.env.NAME` (static) or `process.env[expr]`
    // (dynamic) — i.e. a member access WHOSE OBJECT IS `process.env`.
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
      // Static: process.env.NAME (computed=false, property is an Identifier)
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const access = `process.env.${node.name.text}`;
      hardFails.push({ file: filename, line: line + 1, column: character, access });
      // Do NOT recurse further into this node — we've already captured the
      // full `process.env.NAME` expression. Recursing into children would
      // re-visit `process.env` and generate a spurious standalone report.
      return;
    }

    if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
      // Dynamic: process.env[expr]
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const argText = node.argumentExpression.getText(sourceFile);
      const access = `process.env[${argText}]`;
      reports.push({ file: filename, line: line + 1, column: character, access });
      // Don't recurse; we've captured the access.
      return;
    }

    if (isProcessEnv(node)) {
      // Standalone `process.env` reference — not a member access on env itself.
      // e.g. Object.keys(process.env), spread, assignment to a variable.
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      reports.push({ file: filename, line: line + 1, column: character, access: 'process.env' });
      // Don't recurse into children; we've already captured the standalone ref.
      return;
    }

    // Recurse into all children (module-wide scope — no boundary stops).
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  return {
    hardFail: hardFails.length > 0,
    hardFails,
    reports,
  };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Format an array of per-file `EnvScanResult`s into a clear, build-log-
 * friendly report. Empty results (no files with any hits) → empty string.
 *
 * Each violation is rendered on its own line:
 *
 *   src/workflow.ts:5:14  process.env.SECRET   → migrate to ctx.vars.SECRET
 *   src/dynamic.ts:2:10   process.env[k]        → review dynamic access
 *
 * Hard-fail violations include the `ctx.vars.X` migration hint; dynamic /
 * standalone access lines include a "review" note.
 */
export function formatEnvGateReport(results: EnvScanResult[]): string {
  const allHardFails: Hit[] = [];
  const allReports: Hit[] = [];

  for (const r of results) {
    allHardFails.push(...r.hardFails);
    allReports.push(...r.reports);
  }

  if (allHardFails.length === 0 && allReports.length === 0) {
    return '';
  }

  const lines: string[] = [];

  if (allHardFails.length > 0) {
    lines.push('Workflow modules must not access process.env directly. Migrate to ctx.vars.*:');
    lines.push('');
    for (const hit of allHardFails) {
      const varName = hit.access.replace('process.env.', '');
      lines.push(`  ${hit.file}:${hit.line}:${hit.column}  ${hit.access}   → migrate to ctx.vars.${varName}`);
    }
  }

  if (allReports.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Dynamic / standalone process.env accesses detected (review manually):');
    lines.push('');
    for (const hit of allReports) {
      lines.push(`  ${hit.file}:${hit.line}:${hit.column}  ${hit.access}   → review dynamic access; consider ctx.vars.*`);
    }
  }

  return lines.join('\n');
}
