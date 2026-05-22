/**
 * Task 6.2 — migration codemod.
 *
 * Helps users move OLD workflow source to the NEW `ctx`-based contract. It
 * AUTOFIXES the safe, mechanical cases and REPORTS (does not rewrite) the
 * risky ones. When in doubt between autofix and report, it REPORTS — the
 * codemod rewrites USER CODE, so a wrong rewrite is worse than a manual note.
 *
 * ## AUTOFIX (rewrite `code`)
 *
 *   1. `registerWorkflow(fn)` → `defineWorkflow({ run: fn })`.
 *      Handles both `SolidActions.registerWorkflow(...)` (member call) and a
 *      bare `registerWorkflow(...)` import-call. `fn` may be an arrow or a
 *      function expression (named or anonymous).
 *
 *   2. Static `process.env.IDENT` → `<ctx>.vars.IDENT` — ONLY when the access
 *      is lexically inside a workflow run function where a `ctx`-style param is
 *      (or can be made) in scope. If the run fn has a first param, its name is
 *      REUSED (`async (c) => process.env.X` → `async (c) => c.vars.X`). If it
 *      has NO param, a `ctx` param is INJECTED so the output stays valid.
 *
 * ## REPORT-ONLY (do NOT rewrite, push a human-readable note)
 *
 *   3. Dynamic `process.env[expr]` (computed access): could read a
 *      runtime-computed key — migrate manually to `<ctx>.vars[...]`.
 *   4. `process.env.X` at MODULE TOP-LEVEL (no enclosing run fn, so no `ctx` in
 *      scope): rewriting would produce a ReferenceError. This is the coherence
 *      point with the Task 4.2 env-gate, which HARD-FAILS module-wide
 *      process.env access. The gate blocks; the codemod tells the user how to
 *      fix what it can't safely autofix ("move into the run() body").
 *   5. Spread of `process.env` (`{...process.env}`): a bulk copy, not a named
 *      access — report-only.
 *   6. The old connection-fetch pattern (`getConnection(...)` / broker fetch):
 *      report-only WITH GUIDANCE. The plan is explicit — do NOT auto-rewrite
 *      it until snippet correctness ships.
 *
 * ## COMPOSIO DEPRECATION
 *
 *   7. Any `opts.connections` entry with `broker: 'composio'` produces a
 *      deprecation report. Empty / comment-only source must parse and return
 *      gracefully (never crash).
 *
 * ## Why AST and not regex?
 *
 * Same discipline as `env-gate.ts` / `selfInvokeGate.ts`: the TypeScript
 * compiler API parses the file into an AST where comments and string-literal
 * contents are distinct node kinds from `CallExpression` / `PropertyAccess`
 * nodes. So `// process.env.X` and `"registerWorkflow(x)"` are never touched.
 *
 * ## Why ts.transform + printer (not text splicing)?
 *
 * The two autofixes are STRUCTURAL: `registerWorkflow(fn)` →
 * `defineWorkflow({ run: fn })` wraps an arg in a fresh object literal, and the
 * `process.env.X` → `ctx.vars.X` rewrite needs to know the enclosing run fn's
 * param name (which may itself need to be INJECTED). Position-based text
 * splicing across these interdependent edits is error-prone; the transformer
 * API rebuilds the tree node-by-node with correct nesting, and a single
 * `printer.printFile` emits valid source. The tests are substring-based
 * (`.toContain` / regex), so the printer's reformatting is acceptable.
 *
 * Reports are collected in a separate read-only analysis pass (the transform
 * pass only mutates; it never decides what to report).
 */

import * as ts from 'typescript';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A declared connection, as the codemod caller knows it (from solidactions.yaml). */
export interface CodemodConnection {
  name: string;
  /** Connection broker. `composio` is deprecated; `pica` is the supported path. */
  broker?: string;
}

export interface CodemodOptions {
  /**
   * Declared connections for the project. Used only to surface the Composio
   * deprecation report — it does not influence the source rewrite.
   */
  connections?: CodemodConnection[];
}

export interface CodemodResult {
  /** The transformed source. Unchanged when there was nothing safe to autofix. */
  code: string;
  /** Human-readable migration notes — one per issue the codemod could not/should not autofix. */
  reports: string[];
}

// ---------------------------------------------------------------------------
// AST predicates
// ---------------------------------------------------------------------------

/** The run-fn passed to registerWorkflow / defineWorkflow — arrow or function expression. */
type RunFn = ts.ArrowFunction | ts.FunctionExpression;

function isRunFn(node: ts.Node): node is RunFn {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * Is `node` a call to `registerWorkflow` — either `SolidActions.registerWorkflow(...)`
 * (member call) or a bare `registerWorkflow(...)` (imported identifier)?
 */
function isRegisterWorkflowCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === 'registerWorkflow';
  }
  if (ts.isPropertyAccessExpression(callee)) {
    // X.registerWorkflow(...) — accept any receiver whose terminal member is
    // `registerWorkflow` (covers `SolidActions.registerWorkflow`, and the
    // compiled `sdk_1.SolidActions.registerWorkflow` namespace-alias form).
    return callee.name.text === 'registerWorkflow';
  }
  return false;
}

/** Is `node` exactly `process.env` (property access, not computed)? */
function isProcessEnv(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

/** Is `node` a static `process.env.IDENT` access? */
function isStaticProcessEnvAccess(node: ts.Node): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression);
}

/** Is `node` a dynamic `process.env[expr]` access? */
function isDynamicProcessEnvAccess(node: ts.Node): node is ts.ElementAccessExpression {
  return ts.isElementAccessExpression(node) && isProcessEnv(node.expression);
}

/**
 * Is `node` a spread of `process.env` — `{ ...process.env }` or `[...process.env]`?
 * (SpreadAssignment lives in object literals; SpreadElement in arrays/calls.)
 */
function isProcessEnvSpread(node: ts.Node): boolean {
  if (ts.isSpreadAssignment(node)) {
    return isProcessEnv(node.expression);
  }
  if (ts.isSpreadElement(node)) {
    return isProcessEnv(node.expression);
  }
  return false;
}

/**
 * Is `node` an old-style connection-fetch call — `getConnection(...)` (bare)
 * or `X.getConnection(...)` (member)? Report-only with guidance.
 */
function isConnectionFetchCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === 'getConnection';
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === 'getConnection';
  }
  return false;
}

/**
 * The run fn of a registerWorkflow / defineWorkflow call, if the call has a
 * recognizable run fn.
 *
 *   registerWorkflow(fn)               → fn
 *   defineWorkflow({ run: fn })        → fn
 *
 * Used during analysis to know which lexical regions count as "inside a run fn"
 * for the static-process.env autofix scope. (The transform pass rebuilds
 * registerWorkflow calls into defineWorkflow calls, so both shapes must be
 * recognized.)
 */
function runFnOfWorkflowCall(call: ts.CallExpression): RunFn | undefined {
  // registerWorkflow(fn). Detect via callee shape (NOT the type-predicate
  // helper) so the subsequent defineWorkflow branch keeps its `ts.CallExpression`
  // type — a `node is CallExpression` predicate would narrow the negative
  // branch to `never`.
  const callee = call.expression;
  const calleeName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;

  if (calleeName === 'registerWorkflow') {
    const arg = call.arguments[0];
    if (arg && isRunFn(arg)) {
      return arg;
    }
    return undefined;
  }

  // defineWorkflow({ run: fn })
  if (calleeName === 'defineWorkflow') {
    const arg = call.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ((ts.isIdentifier(prop.name) && prop.name.text === 'run') ||
            (ts.isStringLiteral(prop.name) && prop.name.text === 'run')) &&
          isRunFn(prop.initializer)
        ) {
          return prop.initializer;
        }
      }
    }
  }
  return undefined;
}

/**
 * The name of a run fn's first parameter, if it is a plain identifier binding.
 * Returns `undefined` when the fn has no params (a name must be injected) or
 * the first param is a destructuring pattern (we don't rewrite into those).
 */
function firstParamName(fn: RunFn): string | undefined {
  const p = fn.parameters[0];
  if (p && ts.isIdentifier(p.name)) {
    return p.name.text;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Analysis pass — collect reports (read-only; never mutates)
// ---------------------------------------------------------------------------

/** Format a node's 1-indexed line:col, file-less (codemod takes a source string). */
function loc(sf: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${line + 1}:${character}`;
}

/**
 * Walk the AST collecting report-only notes. The walk tracks whether we are
 * lexically inside a workflow run fn (push/pop a depth counter when entering /
 * leaving such a fn) so that static `process.env.X` accesses can be classified:
 *
 *   - inside a run fn  → autofixed by the transform pass (NOT reported here)
 *   - module top-level → reported here (cannot be safely rewritten)
 */
function collectReports(sf: ts.SourceFile): string[] {
  const reports: string[] = [];
  let runFnDepth = 0;

  function visit(node: ts.Node): void {
    // Are we entering a workflow run fn? Recognize both the old shape
    // (registerWorkflow(fn)) and the new shape (defineWorkflow({run:fn})) so
    // analysis is correct regardless of whether the source has been migrated.
    const enteredRunFn =
      ts.isCallExpression(node) ? runFnOfWorkflowCall(node) : undefined;

    if (enteredRunFn) {
      // Visit children, marking the run fn body as in-scope. We recurse
      // manually so we can flip the depth only across the run fn subtree.
      ts.forEachChild(node, (child) => {
        if (child === enteredRunFn) {
          runFnDepth++;
          visit(child);
          runFnDepth--;
        } else {
          visit(child);
        }
      });
      return;
    }

    // Dynamic process.env[expr] — report-only everywhere.
    if (isDynamicProcessEnvAccess(node)) {
      const argText = node.argumentExpression.getText(sf);
      reports.push(
        `dynamic process.env[${argText}] at ${loc(sf, node)}: migrate manually to ctx.vars[...] (computed keys are not auto-rewritten).`,
      );
      return; // captured; don't recurse into the access itself
    }

    // Static process.env.X — autofixed only inside a run fn; reported at top-level.
    if (isStaticProcessEnvAccess(node)) {
      if (runFnDepth === 0) {
        const name = node.name.text;
        reports.push(
          `module top-level process.env.${name} at ${loc(sf, node)}: move into the workflow run() body; ctx.vars is only available inside run(). Left unchanged (rewriting here would be a ReferenceError).`,
        );
      }
      // Inside a run fn: leave to the transform pass; do not report. Either
      // way, don't recurse into the `process.env` receiver.
      return;
    }

    // Spread of process.env — report-only.
    if (isProcessEnvSpread(node)) {
      reports.push(
        `spread of process.env at ${loc(sf, node)}: enumerate the specific ctx.vars you need instead of copying the whole environment.`,
      );
      return;
    }

    // Old connection-fetch pattern — report-only WITH guidance.
    if (isConnectionFetchCall(node)) {
      reports.push(
        `getConnection(...) at ${loc(sf, node)}: the old connection-fetch pattern is not auto-rewritten. Read connections from ctx.vars.<NAME> (a typed ConnectionVar carrying key + proxy) inside the run() body.`,
      );
      // Continue recursing — args could contain further patterns.
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
  return reports;
}

// ---------------------------------------------------------------------------
// Transform pass — autofix registerWorkflow + static process.env (inside run)
// ---------------------------------------------------------------------------

/**
 * Build the transformer. It performs both structural autofixes in one pass:
 *
 *   1. `registerWorkflow(fn)` → `defineWorkflow({ run: fn })`
 *   2. static `process.env.X` → `<paramName>.vars.X`, but ONLY when lexically
 *      inside a run fn. The transformer tracks the current run fn's param name
 *      via a stack; when a run fn has no first param, a `ctx` param is injected
 *      and pushed so its body's accesses resolve.
 *
 * Module-top-level static accesses (paramStack empty), dynamic accesses, and
 * spreads are left untouched here — they are handled by the report pass.
 */
function makeTransformer(): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    const factory = context.factory;

    // Stack of the in-scope run fn param names. Top of stack = nearest
    // enclosing run fn's ctx param name. Empty = module top-level.
    const paramStack: string[] = [];

    /** Rewrite a run fn so its body's process.env.X → <param>.vars.X, injecting a param if needed. */
    function rewriteRunFn(fn: RunFn): RunFn {
      const existing = firstParamName(fn);
      const paramName = existing ?? 'ctx';

      paramStack.push(paramName);
      // Visit the fn body with the param name in scope.
      const visitedBody = ts.visitNode(fn.body, visitor) as ts.ConciseBody;
      paramStack.pop();

      // Build the (possibly augmented) parameter list.
      let params = fn.parameters;
      if (existing === undefined && fn.parameters.length === 0) {
        // Inject a `ctx` parameter so <param>.vars.X resolves.
        params = factory.createNodeArray([
          factory.createParameterDeclaration(
            /*modifiers*/ undefined,
            /*dotDotDotToken*/ undefined,
            factory.createIdentifier('ctx'),
          ),
        ]);
      }

      if (ts.isArrowFunction(fn)) {
        return factory.updateArrowFunction(
          fn,
          fn.modifiers,
          fn.typeParameters,
          params,
          fn.type,
          fn.equalsGreaterThanToken,
          visitedBody as ts.ConciseBody,
        );
      }
      // FunctionExpression — body is always a Block.
      return factory.updateFunctionExpression(
        fn,
        fn.modifiers,
        fn.asteriskToken,
        fn.name,
        fn.typeParameters,
        params,
        fn.type,
        visitedBody as ts.Block,
      );
    }

    const visitor: ts.Visitor = (node) => {
      // (1) registerWorkflow(fn) → defineWorkflow({ run: fn })
      if (isRegisterWorkflowCall(node)) {
        const arg = node.arguments[0];
        if (arg && isRunFn(arg)) {
          // Rewrite the run fn (handles its body's process.env autofix + param).
          const rewrittenFn = rewriteRunFn(arg);
          const runProp = factory.createPropertyAssignment(
            factory.createIdentifier('run'),
            rewrittenFn,
          );
          // Preserve any extra args the user passed (rare) by ignoring them —
          // registerWorkflow's contract was a single fn. We only wrap arg[0].
          return factory.createCallExpression(
            factory.createIdentifier('defineWorkflow'),
            /*typeArgs*/ undefined,
            [factory.createObjectLiteralExpression([runProp], /*multiLine*/ false)],
          );
        }
        // registerWorkflow(notAFn) — leave as-is; nothing safe to do.
        return ts.visitEachChild(node, visitor, context);
      }

      // (1b) defineWorkflow({ run: fn }) — already-new shape. Still descend into
      // the run fn so its body's process.env.X gets autofixed (covers source
      // that mixes new defineWorkflow with old process.env usage).
      const definedRunFn = ts.isCallExpression(node)
        ? runFnOfWorkflowCall(node)
        : undefined;
      if (definedRunFn && !isRegisterWorkflowCall(node)) {
        // Rebuild the call's object-literal arg with the rewritten run fn.
        const callExpr = node as ts.CallExpression;
        const objArg = callExpr.arguments[0] as ts.ObjectLiteralExpression;
        const newProps = objArg.properties.map((prop) => {
          if (
            ts.isPropertyAssignment(prop) &&
            prop.initializer === definedRunFn
          ) {
            return factory.updatePropertyAssignment(
              prop,
              prop.name,
              rewriteRunFn(definedRunFn),
            );
          }
          return prop;
        });
        return factory.updateCallExpression(
          callExpr,
          callExpr.expression,
          callExpr.typeArguments,
          [
            factory.updateObjectLiteralExpression(objArg, newProps),
            ...callExpr.arguments.slice(1),
          ],
        );
      }

      // (2) static process.env.X → <param>.vars.X, only inside a run fn.
      if (isStaticProcessEnvAccess(node) && paramStack.length > 0) {
        const paramName = paramStack[paramStack.length - 1];
        const varName = node.name.text;
        return factory.createPropertyAccessExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier(paramName),
            factory.createIdentifier('vars'),
          ),
          factory.createIdentifier(varName),
        );
      }

      return ts.visitEachChild(node, visitor, context);
    };

    return (sourceFile) => ts.visitNode(sourceFile, visitor) as ts.SourceFile;
  };
}

// ---------------------------------------------------------------------------
// Detection: does the source contain anything the transform would change?
// ---------------------------------------------------------------------------

/**
 * Returns true if there is at least one safe autofix to apply — a
 * registerWorkflow call, or a static process.env.X access lexically inside a
 * run fn. When false, we return the ORIGINAL source verbatim (the transformer
 * + printer would reformat whitespace; a true no-op must be byte-identical so
 * `code === source` holds for clean inputs).
 */
function hasAutofixableEdit(sf: ts.SourceFile): boolean {
  let found = false;
  let runFnDepth = 0;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }
    if (isRegisterWorkflowCall(node)) {
      found = true;
      return;
    }
    const runFn = ts.isCallExpression(node) ? runFnOfWorkflowCall(node) : undefined;
    if (runFn) {
      ts.forEachChild(node, (child) => {
        if (child === runFn) {
          runFnDepth++;
          visit(child);
          runFnDepth--;
        } else {
          visit(child);
        }
      });
      return;
    }
    if (isStaticProcessEnvAccess(node) && runFnDepth > 0) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
  return found;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the migration codemod over a source string.
 *
 * @param source - The OLD workflow source text.
 * @param opts   - Optional connection metadata (drives the Composio deprecation report).
 * @returns `{ code, reports }` — transformed source + human-readable migration notes.
 */
export function codemod(source: string, opts: CodemodOptions = {}): CodemodResult {
  const reports: string[] = [];

  // --- Composio deprecation (source-independent; never crashes) ---
  for (const conn of opts.connections ?? []) {
    if ((conn.broker ?? '').toLowerCase() === 'composio') {
      reports.push(
        `Connection "${conn.name}" uses the Composio broker, which is deprecated. ` +
          `Migrate it to the Pica proxy contract; Composio-backed connections will not be ` +
          `supported by the new ctx.vars ConnectionVar path.`,
      );
    }
  }

  // Parse once. The TS parser is highly tolerant — empty / comment-only source
  // yields a valid (statement-less) SourceFile, so this never throws.
  const sourceFile = ts.createSourceFile(
    'codemod-input.ts',
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );

  // --- Report pass (read-only) ---
  reports.push(...collectReports(sourceFile));

  // --- Transform pass (autofix) ---
  // Skip entirely when there is nothing safe to rewrite, so clean source is
  // returned byte-identical (the printer would otherwise reformat whitespace).
  if (!hasAutofixableEdit(sourceFile)) {
    return { code: source, reports };
  }

  const result = ts.transform(sourceFile, [makeTransformer()]);
  const transformed = result.transformed[0];

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const code = printer.printFile(transformed);

  result.dispose();

  return { code, reports };
}
