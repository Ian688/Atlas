import ts from 'typescript';

const PREFIX = '/atlas-snapshot/';
const supported = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const fileId = p => `file:${p}`;
const relative = p => p.slice(PREFIX.length);

/** Compile only captured in-memory sources. Never load a project tsconfig/plugin or import it. */
export function parse(request) {
  if (request?.schema !== 'atlas.parse-request.v1' || typeof request.snapshot_id !== 'string' || !Array.isArray(request.files)) {
    throw new Error('invalid_request');
  }
  const sources = new Map();
  for (const f of request.files) {
    if (typeof f.path !== 'string' || typeof f.content !== 'string' || f.path.startsWith('/') || f.path.split('/').some(x => x === '..' || x === '.') || f.path.includes('\\')) throw new Error('invalid_source_path');
    const key = PREFIX + f.path;
    if (sources.has(key)) throw new Error('duplicate_source');
    sources.set(key, f.content);
  }
  const options = { allowJs: true, checkJs: true, noLib: true, noEmit: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve };
  const host = {
    getSourceFile: (name, version) => sources.has(name) ? ts.createSourceFile(name, sources.get(name), version, true) : undefined,
    getDefaultLibFileName: () => '/no-standard-library', writeFile() {},
    getCurrentDirectory: () => PREFIX, getDirectories: () => [],
    fileExists: name => sources.has(name), readFile: name => sources.get(name),
    directoryExists: name => [...sources.keys()].some(p => p.startsWith(name.replace(/\/$/, '') + '/')),
    realpath: p => p, getCanonicalFileName: p => p, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const program = ts.createProgram([...sources.keys()].filter(p => supported.test(p)), options, host);
  const checker = program.getTypeChecker();
  const result = { schema: 'atlas.language-facts.v1', snapshot_id: request.snapshot_id,
    producer: `typescript/${ts.version};worker/0.1.0`, parsed_files: [], symbols: [], calls: [], imports: [], diagnostics: [], dynamic_files: [] };
  const functions = new Map(), declarationIds = new Map(), symbolIds = new Map(), sourceMaps = new Map();
  const scriptBindings = new Map(), ambiguousScriptIds = new Set();
  for (const sf of program.getSourceFiles()) {
    // One O(source length) UTF-16 -> UTF-8 map. Repeated slicing would be quadratic.
    const offsets = new Uint32Array(sf.text.length + 1);
    let utf16 = 0, bytes = 0;
    for (const ch of sf.text) {
      offsets[utf16] = bytes;
      if (ch.length === 2) offsets[utf16 + 1] = bytes;
      utf16 += ch.length; bytes += Buffer.byteLength(ch); offsets[utf16] = bytes;
    }
    sourceMaps.set(sf, offsets);
    const p = relative(sf.fileName);
    // NodeNext may infer module isolation even for scripts intended for a browser.
    // Without a loaded execution profile, require explicit module syntax here.
    const explicitModule=sf.statements.some(n=>ts.isImportDeclaration(n)||ts.isExportDeclaration(n)||ts.isExportAssignment(n)||n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword));
    result.parsed_files.push(p);
    for (const d of program.getSyntacticDiagnostics(sf)) {
      result.diagnostics.push({path:p, code:`TS${d.code}`, detail:ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 300)});
    }
    function walk(node, owner) {
      if (ts.isFunctionLike(node) && node.body) {
        const start = offsets[node.getStart(sf)], end = offsets[node.end];
        const id = `symbol:${p}:${start}:${end}`;
        const parent = node.parent;
        const name = node.name?.getText(sf) || (ts.isVariableDeclaration(parent) ? parent.name.getText(sf) : `<anonymous@${start}>`);
        const record = {id,path:p,name:name.slice(0,256),kind:'function',start,end,container:owner,mutated:false};
        result.symbols.push(record); functions.set(node, record); declarationIds.set(node, id);
        if (!explicitModule && owner === fileId(p) && ts.isFunctionDeclaration(node) && node.name) {
          const group=scriptBindings.get(node.name.text)||[];group.push(id);scriptBindings.set(node.name.text,group);
        }
        let binding = node.name ? checker.getSymbolAtLocation(node.name) : undefined;
        if (ts.isVariableDeclaration(parent)) {
          declarationIds.set(parent, id); binding = checker.getSymbolAtLocation(parent.name);
        }
        if (binding) symbolIds.set(binding, record);
        owner = id;
      }
      ts.forEachChild(node, child => walk(child, owner));
    }
    walk(sf, fileId(p));
  }
  for (const ids of scriptBindings.values()) if(ids.length>1)for(const id of ids)ambiguousScriptIds.add(id);
  const targetOf = expression => {
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    const targets = new Set(symbol?.declarations?.map(d => declarationIds.get(d)).filter(Boolean));
    return targets.size === 1 && !ambiguousScriptIds.has([...targets][0]) ? [...targets][0] : null;
  };
  function markWritten(expression) {
    if(ts.isIdentifier(expression)) {const binding=checker.getSymbolAtLocation(expression);if(symbolIds.has(binding))symbolIds.get(binding).mutated=true;return;}
    if(ts.isPropertyAccessExpression(expression)||ts.isElementAccessExpression(expression))return;
    ts.forEachChild(expression,markWritten);
  }
  for (const sf of program.getSourceFiles()) {
    const p = relative(sf.fileName), offsets = sourceMaps.get(sf);
    let dynamic = false;
    function walk(node, owner) {
      if (functions.has(node)) owner = functions.get(node).id;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        markWritten(node.left);
      }
      if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        if ([ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
          const binding=checker.getSymbolAtLocation(node.operand); if(symbolIds.has(binding))symbolIds.get(binding).mutated=true;
        }
      }
      if (ts.isWithStatement(node)) dynamic = true;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression=node.expression;
        if (ts.isIdentifier(expression) && ['eval','Function'].includes(expression.text)) dynamic=true;
        const start=offsets[node.getStart(sf)],end=offsets[node.end];
        const direct=ts.isIdentifier(expression) && !node.questionDotToken && !ts.isNewExpression(node);
        result.calls.push({id:`call:${p}:${start}:${end}`,path:p,start,end,owner,
          label:expression.getText(sf).slice(0,160),form:direct?'identifier':'dynamic',target:direct?targetOf(expression):null});
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier=node.moduleSpecifier.text;
        const resolved=ts.resolveModuleName(specifier,sf.fileName,options,host).resolvedModule?.resolvedFileName;
        result.imports.push({id:`import:${p}:${offsets[node.getStart(sf)]}`,path:p,specifier,
          target_path:resolved && sources.has(resolved)?relative(resolved):null,type_only:Boolean(node.importClause?.isTypeOnly)});
      }
      ts.forEachChild(node,child=>walk(child,owner));
    }
    walk(sf,fileId(p));
    if(dynamic)result.dynamic_files.push(p);
  }
  for (const key of ['symbols','calls','imports']) result[key].sort((a,b)=>a.id.localeCompare(b.id,'en'));
  result.dynamic_files.sort();
  result.parsed_files.sort();
  return result;
}
