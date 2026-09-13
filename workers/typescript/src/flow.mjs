import ts from 'typescript';

/**
 * Lowers parsed function bodies into the versioned Flow IR
 * (atlas.flow-ir.v1, profile js-structured-control.v1).
 *
 * Evaluation order is encoded by tree order and flattened deterministically by
 * the Rust engine. Constructs outside the declared profile become explicit
 * unknowns with source anchors and reasons; they never silently disappear.
 * This module only reads compiler structures — it never executes analyzed code.
 */

const SHORT_CIRCUIT = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);
const LOGICAL_ASSIGN = new Set([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
const ASSIGNMENT_OPS = new Map([
  [ts.SyntaxKind.EqualsToken, '='],
  [ts.SyntaxKind.PlusEqualsToken, '+='],
  [ts.SyntaxKind.MinusEqualsToken, '-='],
  [ts.SyntaxKind.AsteriskEqualsToken, '*='],
  [ts.SyntaxKind.SlashEqualsToken, '/='],
  [ts.SyntaxKind.PercentEqualsToken, '%='],
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken, '**='],
]);
const UNARY_OPS = new Set([
  ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.TildeToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.TypeOfKeyword,
  ts.SyntaxKind.VoidKeyword,
]);
const VAR_KEYWORDS = new Map([
  [ts.SyntaxKind.LetKeyword, 'let'],
  [ts.SyntaxKind.ConstKeyword, 'const'],
  [ts.SyntaxKind.VarKeyword, 'var'],
]);

export function buildFlow(context) {
  const flow = {
    schema: 'atlas.flow-ir.v1',
    snapshot_id: context.snapshotId,
    producer: `typescript/${ts.version};worker/0.2.1`,
    profile: 'js-structured-control.v1',
    functions: [],
    diagnostics: [],
  };
  for (const [, fileContext] of context.files) {
    new FileBuilder(fileContext, context, flow).buildFile();
  }
  flow.functions.sort((a, b) => a.symbol.localeCompare(b.symbol, 'en'));
  flow.diagnostics.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.code.localeCompare(b.code, 'en'));
  return flow;
}

class FileBuilder {
  constructor(fileContext, context, flow) {
    this.sf = fileContext.sf;
    this.offsets = fileContext.offsets;
    this.path = fileContext.path;
    this.checker = context.checker;
    this.context = context;
    this.flow = flow;
    this.symbolBindings = new Map(); // ts.Symbol -> binding id
    this.declaringFunction = new Map(); // binding id -> owning symbol record id (null = module level)
    this.scopesByStart = new Map(); // `${kind}:${u8start}` -> scope (pre-created)
    this.currentFunction = null;
  }

  /// Register every name a parameter pattern binds, as an ordinary parameter.
  ///
  /// Returns how many were registered, so a pattern this cannot model still
  /// produces its named unknown region instead of vanishing. The shape relation
  /// between the names is not modelled (they are independent unknown values, the
  /// same precision every parameter already has); what changes is that reading
  /// them is now tracked instead of being an untracked read.
  bindParameterPattern(nameNode, scope, fn) {
    let registered = 0;
    const walk = (node) => {
      if (!node) return;
      if (ts.isIdentifier(node)) {
        const symbol = this.checker.getSymbolAtLocation(node);
        const id = this.register(symbol, node, 'param', scope);
        if (id) {
          fn.params.push(id);
          registered += 1;
        }
        return;
      }
      if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
        for (const element of node.elements) {
          if (ts.isBindingElement(element)) walk(element.name);
        }
      }
    };
    walk(nameNode);
    return registered;
  }

  u8(node) {
    return [this.offsets[node.getStart(this.sf)], this.offsets[node.end]];
  }

  noteUnknown(start, end, reason) {
    this.flow.diagnostics.push({ path: this.path, code: 'FLOW_UNKNOWN_REGION', detail: `${reason} [${start},${end})` });
  }

  unknownStmt(node, reason) {
    const [start, end] = this.u8(node);
    return { start, end, stmt: 'unknown', reason };
  }

  unknownExprAt(node, reason) {
    const [start, end] = this.u8(node);
    return { start, end, expr: 'unknown', reason };
  }

  recordForName(nameNode) {
    const record = this.context.recordsByFile.get(this.sf) || [];
    return record.find((r) => r.node.name === nameNode);
  }

  newScope(fn, kind, parent, startOffset) {
    const scope = {
      id: `s:${this.path}:${this.fnStart}:${fn.scopes.length}:${kind}`,
      kind,
      parent: parent ? parent.id : null,
      bindings: [],
    };
    fn.scopes.push(scope);
    if (startOffset !== undefined) this.scopesByStart.set(`${kind}:${startOffset}`, scope);
    return scope;
  }

  register(symbol, nameNode, kind, scope, opts = {}) {
    if (!symbol) return undefined;
    const existing = this.symbolBindings.get(symbol);
    if (existing) return existing;
    const [ds, de] = this.u8(nameNode);
    const id = `b:${this.path}:${ds}:${nameNode.getText(this.sf).slice(0, 64)}`;
    const binding = {
      id,
      name: nameNode.getText(this.sf).slice(0, 128),
      kind,
      scope: scope.id,
      decl_start: ds,
      decl_end: de,
      hoisted: Boolean(opts.hoisted),
    };
    if (opts.function_symbol) binding.function_symbol = opts.function_symbol;
    this.symbolBindings.set(symbol, id);
    scope.bindings.push(id);
    this.currentFunction.bindings.push(binding);
    this.declaringFunction.set(id, opts.module ? null : this.currentFunction.symbol);
    return id;
  }

  buildFile() {
    // Pass 0: register module-level declaration names so hoisted, recursive and
    // mutual references between functions resolve to real bindings.
    // Runtime import local names. A type-only import is erased and introduces
    // no binding, so listing it would make the engine treat an undefined read as
    // provided module state.
    const moduleImports = [];
    for (const stmt of this.sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.importClause || stmt.importClause.isTypeOnly) continue;
      const clause = stmt.importClause;
      if (clause.name) moduleImports.push(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) moduleImports.push(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) moduleImports.push(element.name.text);
    }
    const moduleNames = [];
    const walkModule = (node) => {
      // Module scope only: never descend into a function or class body, whose
      // locals belong to their own scope. Stopping only at *declarations* left
      // function expressions and arrow IIFEs exposed, so a UMD bundle's factory
      // IIFE contributed its whole local list to `moduleNames`. Every function
      // then tried to register those names, the first one built claimed them,
      // and the IIFE that really declared them was left with 100+ dangling
      // references (found by indexing the real rxjs@7.8.1 UMD bundle).
      if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) moduleNames.push(node.name);
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) moduleNames.push(decl.name);
        }
        return;
      }
      ts.forEachChild(node, walkModule);
    };
    for (const stmt of this.sf.statements) walkModule(stmt);
    const records = this.context.recordsByFile.get(this.sf) || [];
    // Pass 1: build every function body (preorder; outer before inner).
    for (const record of records) this.buildFunction(record, moduleNames, moduleImports);
  }

  buildFunction(record, moduleNames, moduleImports = []) {
    const node = record.node;
    const [fnStart, fnEnd] = this.u8(node);
    const fn = {
      symbol: record.id,
      name: String(record.name || '<anonymous>').slice(0, 256),
      path: this.path,
      start: fnStart,
      end: fnEnd,
      params: [],
      imports: [...new Set(moduleImports)].sort(),
      scopes: [],
      bindings: [],
      body: [],
      captures: [],
      unknown_regions: [],
    };
    this.currentFunction = fn;
    this.fnStart = fnStart;
    this.captured = new Set();
    const fnScope = this.newScope(fn, 'function', null);
    for (const nameNode of moduleNames) {
      const sym = this.checker.getSymbolAtLocation(nameNode);
      const isFn = ts.isFunctionDeclaration(nameNode.parent);
      const nested = isFn ? this.recordForName(nameNode) : undefined;
      if (sym) this.register(sym, nameNode, isFn ? 'function' : 'let', fnScope, { module: true, hoisted: isFn, function_symbol: nested && nested.id });
    }
    if (node.name && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isMethodDeclaration(node)) {
      const sym = this.checker.getSymbolAtLocation(node.name);
      if (sym) this.register(sym, node.name, 'function', fnScope, { hoisted: true, function_symbol: record.id });
    }
    // Register every parameter first so parameter default expressions can
    // reference earlier parameters.
    const defaultInitializers = [];
    for (const param of node.parameters) {
      if (param.dotDotDotToken || !ts.isIdentifier(param.name)) {
        // A rest parameter is an array of unknown values; a destructuring
        // pattern binds several unknown values. Neither is a reason to stop
        // analysing the function. Bailing here was worse than one extra unknown
        // region: the names never entered the binding table, so every later read
        // of them became an untracked read and the whole function carried a
        // hole. Measured on rxjs@7.8.1, these two shapes were 88 of the 167
        // explicitly unknown regions -- 53% of them.
        //
        // The values really are unknown, and that is a conclusion -- the same
        // conclusion every ordinary parameter gets -- so the names are
        // registered like ordinary parameters. A pattern this cannot walk (a
        // computed member, say) still produces the named region, so nothing
        // disappears silently.
        const reason = param.dotDotDotToken ? 'rest_parameter' : 'destructuring_parameter';
        if (this.bindParameterPattern(param.name, fnScope, fn) === 0) {
          const [ds, de] = this.u8(param.name);
          fn.unknown_regions.push({ start: ds, end: de, reason });
          this.noteUnknown(ds, de, reason);
        }
        continue;
      }
      const sym = this.checker.getSymbolAtLocation(param.name);
      const id = this.register(sym, param.name, 'param', fnScope);
      if (id) fn.params.push(id);
      if (id && param.initializer) defaultInitializers.push([id, param.initializer]);
    }
    for (const [id, initializer] of defaultInitializers) {
      const value = this.lower(initializer, fn, this.captured);
      const binding = fn.bindings.find((b) => b.id === id);
      if (binding) binding.default_value = value;
    }
    if (node.body) {
      const isBlock = ts.isBlock(node.body);
      if (isBlock) this.collectDeclarations(node.body, fn, fnScope);
      if (isBlock) {
        fn.body = node.body.statements.map((stmt) => this.lowerStmt(stmt, fn, fnScope));
      } else {
        // Expression-bodied arrow: `() => expr` behaves as `return expr`.
        const [bs, be] = this.u8(node.body);
        fn.body = [{ start: bs, end: be, stmt: 'return', value: this.lower(node.body, fn, this.captured) }];
      }
    }
    fn.captures = [...this.captured].sort();
    fn.bindings = fn.bindings.filter((b) => fn.scopes.some((s) => s.id === b.scope));
    this.flow.functions.push(fn);
    this.currentFunction = null;
  }

  // Pre-walk collecting declarations so use-before-declare (TDZ) still binds.
  collectDeclarations(root, fn, fnScope) {
    const enter = (node, scope) => {
      let childScope = scope;
      // A nested function's own declarations belong to that function, never to
      // this one. Descending through a function body here used to claim an
      // inner `let` for the enclosing function, so the inner function's own
      // declarator referenced a binding it did not declare -- which the Rust
      // validator correctly rejected as flow_reference_unknown_binding. Found
      // by indexing the real rxjs@7.8.1 tree (src/internal/Observable.ts).
      if (ts.isFunctionLike(node)) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const sym = this.checker.getSymbolAtLocation(node.name);
          const nested = this.recordForName(node.name);
          if (sym) this.register(sym, node.name, 'function', fnScope, { hoisted: true, function_symbol: nested && nested.id });
        }
        return;
      }
      // Class bodies are their own function scopes for the same reason.
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        if (node.name) {
          const sym = this.checker.getSymbolAtLocation(node.name);
          if (sym) this.register(sym, node.name, 'let', scope);
        }
        return;
      }
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          const sym = this.checker.getSymbolAtLocation(node.name);
          const list = node.parent;
          const keyword = VAR_KEYWORDS.get(list.getChildAt(0).kind) || 'let';
          if (sym) this.register(sym, node.name, keyword === 'var' ? 'var' : keyword, keyword === 'var' ? fnScope : scope, { hoisted: keyword === 'var' });
        } else {
          const [ds, de] = this.u8(node.name);
          fn.unknown_regions.push({ start: ds, end: de, reason: 'destructuring_declaration' });
          for (const el of node.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              const sym = this.checker.getSymbolAtLocation(el.name);
              if (sym) this.register(sym, el.name, 'let', scope);
            }
          }
        }
      } else if (ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        childScope = this.newScope(fn, ts.isBlock(node) ? 'block' : 'for', scope, this.offsets[node.getStart(this.sf)]);
      } else if (ts.isSwitchStatement(node)) {
        childScope = this.newScope(fn, 'switch', scope, this.offsets[node.getStart(this.sf)]);
      } else if (ts.isCatchClause(node)) {
        childScope = this.newScope(fn, 'catch', scope, this.offsets[node.getStart(this.sf)]);
        if (node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
          const sym = this.checker.getSymbolAtLocation(node.variableDeclaration.name);
          if (sym) this.register(sym, node.variableDeclaration.name, 'catch', childScope);
        }
      }
      ts.forEachChild(node, (child) => enter(child, childScope));
    };
    enter(root, fnScope);
  }

  scopeFor(kind, startOffset, fallback) {
    return this.scopesByStart.get(`${kind}:${startOffset}`) || fallback;
  }

  lowerStmt(node, fn, scope) {
    try {
      return this.lowerStmtInner(node, fn, scope);
    } catch (error) {
      const [start, end] = this.u8(node);
      this.noteUnknown(start, end, `internal_lowering_failure:${error && error.message}`);
      return { start, end, stmt: 'unknown', reason: `internal_lowering_failure:${error && error.message}` };
    }
  }

  lowerStmtInner(node, fn, scope) {
    const [start, end] = this.u8(node);
    if (ts.isVariableStatement(node)) {
      return { ...this.lowerVarList(node.declarationList, fn, scope), start, end };
    }
    if (ts.isExpressionStatement(node)) {
      return { start, end, stmt: 'expression', expr: this.lower(node.expression, fn) };
    }
    if (ts.isIfStatement(node)) {
      return {
        start,
        end,
        stmt: 'if',
        cond: this.lower(node.expression, fn),
        then_body: [this.lowerStmt(node.thenStatement, fn, scope)],
        else_body: node.elseStatement ? [this.lowerStmt(node.elseStatement, fn, scope)] : [],
      };
    }
    if (ts.isWhileStatement(node)) {
      return { start, end, stmt: 'while', cond: this.lower(node.expression, fn), body: [this.lowerStmt(node.statement, fn, scope)] };
    }
    if (ts.isDoStatement(node)) {
      return { start, end, stmt: 'do_while', body: [this.lowerStmt(node.statement, fn, scope)], cond: this.lower(node.expression, fn) };
    }
    if (ts.isForStatement(node)) {
      const forScope = this.scopeFor('for', start, scope);
      const init = node.initializer
        ? ts.isVariableDeclarationList(node.initializer)
          ? { ...this.lowerVarList(node.initializer, fn, forScope), start: this.offsets[node.initializer.getStart(this.sf)], end: this.offsets[node.initializer.end] }
          : { start: this.offsets[node.initializer.getStart(this.sf)], end: this.offsets[node.initializer.end], stmt: 'expression', expr: this.lower(node.initializer, fn) }
        : undefined;
      return {
        start,
        end,
        stmt: 'for',
        init,
        cond: node.condition ? this.lower(node.condition, fn) : undefined,
        update: node.incrementor ? this.lower(node.incrementor, fn) : undefined,
        body: [this.lowerStmt(node.statement, fn, forScope)],
      };
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      // `for (const x of items) body` runs an unknown number of times and binds
      // x to an unknown element. Returning a statement-level unknown also threw
      // away every call in the header and the body -- on rxjs that was 79
      // regions, in code whose calls then became invisible to every downstream
      // fact. The loop is modelled with forms the IR already has: a `while`
      // whose condition is unknown (so it may run zero times), the iterated
      // expression lowered as the condition so its calls stay visible, and the
      // bound name registered with its real kind and an unknown value, which is
      // what a loop variable is on any given iteration.
      const loopScope = this.scopeFor('for', start, scope);
      // `for (x of y)` without a declaration binds an existing name; only the
      // declaration form creates bindings here.
      if (ts.isVariableDeclarationList(node.initializer)) {
        const isConst = (node.initializer.flags & ts.NodeFlags.Const) !== 0;
        for (const declaration of node.initializer.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            const symbol = this.checker.getSymbolAtLocation(declaration.name);
            this.register(symbol, declaration.name, isConst ? 'const' : 'let', loopScope);
          } else {
            this.bindParameterPattern(declaration.name, loopScope, fn);
          }
        }
      }
      return {
        start,
        end,
        stmt: 'while',
        cond: this.lower(node.expression, fn),
        body: [this.lowerStmt(node.statement, fn, loopScope)],
      };
    }
    if (ts.isSwitchStatement(node)) {
      const switchScope = this.scopeFor('switch', start, scope);
      const cases = node.caseBlock.clauses.map((clause) => ({
        test: clause.expression ? this.lower(clause.expression, fn) : undefined,
        body: clause.statements.map((s) => this.lowerStmt(s, fn, switchScope)),
      }));
      return { start, end, stmt: 'switch', discriminant: this.lower(node.expression, fn), cases };
    }
    if (ts.isReturnStatement(node)) {
      return { start, end, stmt: 'return', value: node.expression ? this.lower(node.expression, fn) : undefined };
    }
    if (ts.isThrowStatement(node)) {
      return { start, end, stmt: 'throw', expr: this.lower(node.expression, fn) };
    }
    if (ts.isBreakStatement(node)) {
      return { start, end, stmt: 'break', label: node.label ? node.label.text : undefined };
    }
    if (ts.isContinueStatement(node)) {
      return { start, end, stmt: 'continue', label: node.label ? node.label.text : undefined };
    }
    if (ts.isTryStatement(node)) {
      const catchClause = node.catchClause;
      const catchScope = catchClause ? this.scopeFor('catch', this.offsets[catchClause.getStart(this.sf)], scope) : scope;
      return {
        start,
        end,
        stmt: 'try',
        body: node.tryBlock.statements.map((s) => this.lowerStmt(s, fn, scope)),
        catch_param: catchClause && catchScope.bindings[0] ? catchScope.bindings[0] : undefined,
        catch_body: catchClause ? catchClause.block.statements.map((s) => this.lowerStmt(s, fn, catchScope)) : undefined,
        finally_body: node.finallyBlock ? node.finallyBlock.statements.map((s) => this.lowerStmt(s, fn, scope)) : undefined,
      };
    }
    if (ts.isLabeledStatement(node)) {
      return { start, end, stmt: 'labeled', label: node.label.text, body: this.lowerStmt(node.statement, fn, scope) };
    }
    if (ts.isBlock(node)) {
      const blockScope = this.scopeFor('block', start, scope);
      return { start, end, stmt: 'block', body: node.statements.map((s) => this.lowerStmt(s, fn, blockScope)) };
    }
    if (ts.isFunctionDeclaration(node)) {
      // Hoisted: its binding is seeded with the function value at scope entry.
      return { start, end, stmt: 'empty' };
    }
    if (ts.isClassDeclaration(node)) {
      this.noteUnknown(start, end, 'class_declaration');
      return { start, end, stmt: 'unknown', reason: 'class_declaration' };
    }
    if (ts.isWithStatement(node)) {
      this.noteUnknown(start, end, 'with_statement');
      return { start, end, stmt: 'unknown', reason: 'with_statement' };
    }
    if (ts.isEmptyStatement(node)) return { start, end, stmt: 'empty' };
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      return { start, end, stmt: 'empty' };
    }
    this.noteUnknown(start, end, `unsupported_statement:${ts.SyntaxKind[node.kind]}`);
    return { start, end, stmt: 'unknown', reason: `unsupported_statement:${ts.SyntaxKind[node.kind]}` };
  }

  lowerVarList(list, fn, scope) {
    const keyword = VAR_KEYWORDS.get(list.getChildAt(0).kind) || 'let';
    const declarators = [];
    for (const decl of list.declarations) {
      if (!ts.isIdentifier(decl.name)) return { stmt: 'unknown', reason: 'destructuring_declaration' };
      const id = this.symbolBindings.get(this.checker.getSymbolAtLocation(decl.name));
      if (!id) return { stmt: 'unknown', reason: 'unresolved_declaration_symbol' };
      declarators.push({ binding: id, init: decl.initializer ? this.lower(decl.initializer, fn) : undefined });
    }
    return { stmt: 'var_decl', keyword, declarators };
  }

  lower(node, fn) {
    const [start, end] = this.u8(node);
    try {
      return this.lowerExpr(node, fn);
    } catch (error) {
      this.noteUnknown(start, end, `internal_lowering_failure:${error && error.message}`);
      return { start, end, expr: 'unknown', reason: `internal_lowering_failure:${error && error.message}` };
    }
  }

  lowerExpr(node, fn) {
    const [start, end] = this.u8(node);
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      // A literal such as 1e999 overflows to Infinity. JSON has no token for a
      // non-finite number, so a `num` constant would reach the engine as null
      // and fail the whole response for every file, not just this function.
      // The profile does not model non-finite numeric literals: report an
      // explicit unknown instead of a constant that cannot cross the wire.
      if (!Number.isFinite(value)) return { start, end, expr: 'unknown', reason: 'non_finite_numeric_literal' };
      return { start, end, expr: 'const', value: { const: 'num', value } };
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { start, end, expr: 'const', value: { const: 'str', value: node.text } };
    if (ts.isRegularExpressionLiteral(node)) return { start, end, expr: 'unknown', reason: 'regex_literal' };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { start, end, expr: 'const', value: { const: 'bool', value: true } };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { start, end, expr: 'const', value: { const: 'bool', value: false } };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { start, end, expr: 'const', value: { const: 'null' } };
    if (ts.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      const bindingId = symbol && this.symbolBindings.get(symbol);
      if (bindingId) {
        if (this.declaringFunction.get(bindingId) !== (this.currentFunction && this.currentFunction.symbol)) this.captured.add(bindingId);
        return { start, end, expr: 'local', binding: bindingId };
      }
      // FIXED(V-08b): only fold `undefined` to the global constant AFTER scope
      // resolution. A parameter or local named `undefined` is a real binding;
      // folding it by name produced a definite value for an unknown one.
      if (node.text === 'undefined') return { start, end, expr: 'const', value: { const: 'undefined' } };
      return { start, end, expr: 'external', name: node.text };
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) return { start, end, expr: 'this' };
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const record = this.context.functions.get(node);
      if (!record) return { start, end, expr: 'unknown', reason: 'nested_function_without_symbol' };
      return { start, end, expr: 'function_ref', symbol: record.id };
    }
    if (ts.isBinaryExpression(node)) {
      const opKind = node.operatorToken.kind;
      if (SHORT_CIRCUIT.has(opKind)) {
        return {
          start,
          end,
          expr: 'short_circuit',
          op: opKind === ts.SyntaxKind.AmpersandAmpersandToken ? '&&' : opKind === ts.SyntaxKind.BarBarToken ? '||' : '??',
          left: this.lower(node.left, fn),
          right: this.lower(node.right, fn),
        };
      }
      if (LOGICAL_ASSIGN.has(opKind)) return { start, end, expr: 'unknown', reason: 'logical_assignment_operator' };
      const assignOp = ASSIGNMENT_OPS.get(opKind);
      if (assignOp) {
        return { start, end, expr: 'assign', op: assignOp, target: this.assignTarget(node.left, fn), value: this.lower(node.right, fn) };
      }
      return { start, end, expr: 'binary', op: ts.tokenToString(opKind) || 'unknown_operator', left: this.lower(node.left, fn), right: this.lower(node.right, fn) };
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
        return {
          start,
          end,
          expr: 'assign',
          op: node.operator === ts.SyntaxKind.PlusPlusToken ? '++' : '--',
          target: this.assignTarget(node.operand, fn),
          value: { start, end, expr: 'unknown', reason: 'increment_result_unknown' },
        };
      }
      if (node.kind === ts.SyntaxKind.DeleteExpression) return { start, end, expr: 'unknown', reason: 'delete_expression' };
      if (!UNARY_OPS.has(node.operator)) return { start, end, expr: 'unknown', reason: `unsupported_unary:${ts.tokenToString(node.operator) || node.operator}` };
      return { start, end, expr: 'unary', op: ts.tokenToString(node.operator), operand: this.lower(node.operand, fn) };
    }
    if (ts.isConditionalExpression(node)) {
      return { start, end, expr: 'conditional', cond: this.lower(node.condition, fn), then_value: this.lower(node.whenTrue, fn), else_value: this.lower(node.whenFalse, fn) };
    }
    if (ts.isCallExpression(node)) {
      return {
        start,
        end,
        expr: 'call',
        callee: this.lower(node.expression, fn),
        args: node.arguments.map((a) => (ts.isSpreadElement(a) ? { start: this.offsets[a.getStart(this.sf)], end: this.offsets[a.end], expr: 'unknown', reason: 'spread_argument' } : this.lower(a, fn))),
        optional: Boolean(node.questionDotToken),
      };
    }
    if (ts.isNewExpression(node)) {
      return { start, end, expr: 'new', callee: this.lower(node.expression, fn), args: (node.arguments || []).map((a) => this.lower(a, fn)) };
    }
    if (ts.isPropertyAccessExpression(node)) {
      return { start, end, expr: 'property_read', object: this.lower(node.expression, fn), name: node.name.text, optional: Boolean(node.questionDotToken) };
    }
    if (ts.isElementAccessExpression(node)) return { start, end, expr: 'unknown', reason: 'element_access' };
    if (ts.isObjectLiteralExpression(node)) {
      const fields = [];
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          fields.push({ name: prop.name.getText(this.sf).replace(/^['"]|['"]$/g, ''), value: this.lower(prop.initializer, fn) });
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          fields.push({ name: prop.name.text, value: this.lower(prop.name, fn) });
        } else {
          return { start, end, expr: 'unknown', reason: `unsupported_object_member:${ts.SyntaxKind[prop.kind]}` };
        }
      }
      return { start, end, expr: 'object_literal', fields };
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) {
        if (ts.isSpreadElement(el) || el.kind === ts.SyntaxKind.OmittedExpression) return { start, end, expr: 'unknown', reason: 'array_spread_or_hole' };
      }
      return { start, end, expr: 'array_literal', elements: node.elements.map((el) => this.lower(el, fn)) };
    }
    if (ts.isTemplateExpression(node)) return { start, end, expr: 'unknown', reason: 'template_substitution' };
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
      return this.lower(node.expression, fn);
    }
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) return { start, end, expr: 'unknown', reason: 'await_or_yield' };
    if (ts.isTaggedTemplateExpression(node)) return { start, end, expr: 'unknown', reason: 'tagged_template' };
    if (node.kind === ts.SyntaxKind.SuperKeyword) return { start, end, expr: 'unknown', reason: 'super_reference' };
    if (String(ts.SyntaxKind[node.kind]).startsWith('Jsx')) return { start, end, expr: 'unknown', reason: 'jsx_expression' };
    return { start, end, expr: 'unknown', reason: `unsupported_expression:${ts.SyntaxKind[node.kind]}` };
  }

  assignTarget(node, fn) {
    if (ts.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      const bindingId = symbol && this.symbolBindings.get(symbol);
      if (bindingId) {
        if (this.declaringFunction.get(bindingId) !== (this.currentFunction && this.currentFunction.symbol)) this.captured.add(bindingId);
        return { target: 'binding', binding: bindingId };
      }
      return { target: 'unknown' };
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      return { target: 'property', object: this.lower(node.expression, fn), name: node.name.text };
    }
    return { target: 'unknown' };
  }
}
