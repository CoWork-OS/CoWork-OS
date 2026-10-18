import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const directory = path.join(import.meta.dirname, "mermaid-parser");
const sourceLock = JSON.parse(readFileSync(path.join(directory, "source-lock.json"), "utf8"));
const barrels = JSON.parse(readFileSync(path.join(directory, "upstream-barrels.json"), "utf8"));
const prefix = "\0cowork-mermaid-parser/";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function invariant(condition, message) {
  if (!condition) throw new Error(`Mermaid parser source adaptation: ${message}`);
}

function packageOf(entry, expectedName) {
  let directory = path.dirname(entry);
  while (directory !== path.dirname(directory)) {
    try {
      const file = path.join(directory, "package.json");
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data.name === expectedName) return { directory, file, data };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot locate ${expectedName} package for ${entry}`);
}

export function verifyMermaidParserSources(sources, lock = sourceLock) {
  invariant(sources.size === Object.keys(lock.sources).length, "source inventory changed");
  for (const [name, expected] of Object.entries(lock.sources)) {
    invariant(sources.has(name), `missing original source ${name}`);
    invariant(sha256(sources.get(name)) === expected, `content changed in ${name}`);
  }
}

/** The only side-effect flags belong to the 18 proven forwarding barrels. */
export function verifyMermaidParserSourceShape(sources) {
  for (const [name, source] of sources) {
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    if (Object.hasOwn(barrels, name)) {
      invariant(
        ast.statements.every(
          (node) =>
            ts.isExportDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly),
        ),
        `barrel has runtime statements in ${name}`,
      );
    }
    // The pinned implementation sources only declare values/functions/classes.
    // Their two eager allocation forms are internal reflection/cache state:
    // one generated AstReflection instance, and literal validator membership Sets.
    // There are no top-level registrations, I/O, mutations or external calls.
    for (const node of ast.statements)
      invariant(
        ts.isImportDeclaration(node) ||
          ts.isExportDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isVariableStatement(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isModuleDeclaration(node),
        `unexpected top-level statement in ${name}`,
      );
    const visit = (node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isModuleDeclaration(node)) {
        invariant(
          name === "src/language/generated/ast.ts" &&
            node.body &&
            ts.isModuleBlock(node.body) &&
            node.body.statements.every(
              (statement) =>
                ts.isTypeAliasDeclaration(statement) ||
                (ts.isVariableStatement(statement) &&
                  statement.declarationList.declarations.every(
                    (declaration) =>
                      ts.isIdentifier(declaration.name) &&
                      declaration.name.text === "Terminals" &&
                      declaration.initializer &&
                      ts.isObjectLiteralExpression(declaration.initializer) &&
                      declaration.initializer.properties.every(
                        (property) =>
                          ts.isPropertyAssignment(property) &&
                          ts.isRegularExpressionLiteral(property.initializer),
                      ),
                  )),
            ),
          `unexpected generated namespace in ${name}`,
        );
      }
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const heritage of node.heritageClauses ?? []) ts.forEachChild(heritage, visit);
        for (const member of node.members)
          if (member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
            visit(member);
        return;
      }
      invariant(
        !(
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) &&
          !ts.isPostfixUnaryExpression(node) &&
          !(
            ts.isPrefixUnaryExpression(node) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
          ) &&
          !ts.isDeleteExpression(node) &&
          !ts.isAwaitExpression(node) &&
          !ts.isYieldExpression(node) &&
          !ts.isTaggedTemplateExpression(node),
        `top-level mutation/effect in ${name}`,
      );
      invariant(!ts.isCallExpression(node), `top-level call in ${name}`);
      if (ts.isNewExpression(node)) {
        const reflection =
          name === "src/language/generated/ast.ts" &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "MermaidAstReflection" &&
          node.arguments?.length === 0;
        const sets =
          name === "src/language/eventmodeling/event-modeling-validator.ts" &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "Set" &&
          node.arguments?.length === 1 &&
          ts.isArrayLiteralExpression(node.arguments[0]) &&
          node.arguments[0].elements.every(ts.isStringLiteral);
        invariant(reflection || sets, `unexpected top-level allocation in ${name}`);
        invariant(
          ts.isVariableDeclaration(node.parent) &&
            ts.isVariableDeclarationList(node.parent.parent) &&
            ts.isVariableStatement(node.parent.parent.parent) &&
            (reflection ||
              !node.parent.parent.parent.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
              )),
          `unexpected allocation binding in ${name}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
}

/** Load the exact TypeScript published in the installed parser's source maps. */
export function loadMermaidParserSources({ parserEntry, mermaidEntry, langiumEntry }) {
  const parser = packageOf(parserEntry, "@mermaid-js/parser");
  const mermaid = packageOf(mermaidEntry, "mermaid");
  const langium = packageOf(langiumEntry, "langium");
  for (const [name, actual, expected] of [
    ["@mermaid-js/parser", parser.data.version, sourceLock.parserVersion],
    ["mermaid", mermaid.data.version, sourceLock.mermaidVersion],
    ["langium", langium.data.version, sourceLock.langiumVersion],
  ])
    invariant(actual === expected, `unsupported ${name} version ${actual}; expected ${expected}`);
  invariant(
    path.resolve(parserEntry) === path.join(parser.directory, "dist/mermaid-parser.core.mjs"),
    "unexpected parser entry point",
  );
  const dist = path.join(parser.directory, "dist");
  const chunkDirectory = path.join(dist, "chunks/mermaid-parser.core");
  const maps = [
    path.join(dist, "mermaid-parser.core.mjs.map"),
    ...readdirSync(chunkDirectory)
      .filter((file) => file.endsWith(".map"))
      .map((file) => path.join(chunkDirectory, file)),
  ];
  const sources = new Map();
  for (const file of maps) {
    const map = JSON.parse(readFileSync(file, "utf8"));
    for (let i = 0; i < map.sources.length; i++) {
      const match = /^(?:\.\.\/)+src\/(.+)$/.exec(map.sources[i]);
      if (!match) continue;
      const name = `src/${match[1]}`;
      invariant(typeof map.sourcesContent?.[i] === "string", `missing source content for ${name}`);
      invariant(
        !sources.has(name) || sources.get(name) === map.sourcesContent[i],
        `conflicting source ${name}`,
      );
      sources.set(name, map.sourcesContent[i]);
    }
  }
  for (const [name, source] of Object.entries(barrels)) {
    invariant(!sources.has(name), `upstream now publishes barrel ${name}`);
    sources.set(name, source);
  }
  verifyMermaidParserSources(sources);
  verifyMermaidParserSourceShape(sources);
  return {
    sources: partitionMermaidParserSources(sources),
    watchFiles: [
      ...maps,
      parser.file,
      mermaid.file,
      langium.file,
      path.join(directory, "source-lock.json"),
      path.join(directory, "upstream-barrels.json"),
    ],
  };
}

function identifiers(nodes) {
  const result = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node)) result.add(node.text);
    ts.forEachChild(node, visit);
  };
  nodes.forEach(visit);
  return result;
}

/**
 * Change module boundaries, preserving each generated declaration verbatim.
 * Every grammar keeps its original private, once-only cached Grammar object.
 */
export function partitionMermaidParserSources(original) {
  const sources = new Map(original);
  for (const [kind, exportCount, privateCount] of [
    ["grammar", 15, 15],
    ["module", 31, 0],
  ]) {
    const name = `src/language/generated/${kind}.ts`;
    const source = sources.get(name);
    invariant(typeof source === "string", `missing ${name}`);
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(ts.isImportDeclaration);
    const exported = new Map();
    const privateDeclarations = new Map();
    for (const node of ast.statements) {
      if (ts.isImportDeclaration(node)) continue;
      invariant(ts.isVariableStatement(node), `unexpected ${kind} statement`);
      invariant(node.declarationList.declarations.length === 1, `combined ${kind} declaration`);
      const declaration = node.declarationList.declarations[0];
      invariant(ts.isIdentifier(declaration.name), `non-identifier ${kind} declaration`);
      const target = node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
        ? exported
        : privateDeclarations;
      invariant(!target.has(declaration.name.text), `duplicate ${kind} declaration`);
      target.set(declaration.name.text, node);
    }
    invariant(
      exported.size === exportCount && privateDeclarations.size === privateCount,
      `unexpected ${kind} declaration inventory`,
    );
    const cacheOwners = new Map();
    for (const [binding, declaration] of exported) {
      const references = identifiers([declaration]);
      const locals = [...privateDeclarations].filter(([name]) => references.has(name));
      invariant(kind !== "grammar" || locals.length === 1, `grammar cache missing for ${binding}`);
      for (const [cache] of locals) {
        invariant(!cacheOwners.has(cache), `shared cache ${cache}`);
        cacheOwners.set(cache, binding);
      }
      const used = identifiers([declaration, ...locals.map(([, node]) => node)]);
      const declarations = [];
      for (const node of imports) {
        const clause = node.importClause;
        invariant(
          clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings),
          `unexpected ${kind} import`,
        );
        const specifier = node.moduleSpecifier.text;
        const relocated = specifier.startsWith("./") ? `../${specifier.slice(2)}` : specifier;
        for (const element of clause.namedBindings.elements) {
          if (!used.has(element.name.text)) continue;
          const imported = element.propertyName?.text ?? element.name.text;
          const target =
            specifier === "./grammar.js" ? `../grammar-parts/${imported}.js` : relocated;
          declarations.push(
            `import ${clause.isTypeOnly || element.isTypeOnly ? "type " : ""}{ ${element.getText(ast).replace(/^type /, "")} } from ${JSON.stringify(target)};`,
          );
        }
      }
      for (const dependency of exported.keys()) {
        if (dependency !== binding && used.has(dependency))
          declarations.push(`import { ${dependency} } from './${dependency}.js';`);
      }
      sources.set(
        `src/language/generated/${kind}-parts/${binding}.ts`,
        [
          ...declarations,
          ...locals.map(([, node]) => node.getText(ast)),
          declaration.getText(ast),
        ].join("\n") + "\n",
      );
    }
    invariant(cacheOwners.size === privateCount, `unowned ${kind} cache`);
    sources.set(
      name,
      [...exported.keys()]
        .map((binding) => `export { ${binding} } from './${kind}-parts/${binding}.js';`)
        .join("\n") + "\n",
    );
  }
  // Direct binding imports matter: importing the shared generated barrel would
  // make bundlers merge all 15 grammars back into one eagerly evaluated module.
  for (const [name, source] of sources) {
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const edits = [];
    for (const node of ast.statements) {
      if (
        !ts.isImportDeclaration(node) ||
        !node.moduleSpecifier.text.endsWith("/generated/module.js")
      )
        continue;
      const clause = node.importClause;
      invariant(
        clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings),
        `unexpected generated binding import in ${name}`,
      );
      const replacement = clause.namedBindings.elements
        .map((binding) => {
          const imported = binding.propertyName?.text ?? binding.name.text;
          const target = node.moduleSpecifier.text.replace(
            /module\.js$/,
            `module-parts/${imported}.js`,
          );
          invariant(
            sources.has(
              path.posix
                .normalize(path.posix.join(path.posix.dirname(name), target))
                .replace(/\.js$/, ".ts"),
            ),
            `unknown generated binding ${imported}`,
          );
          return `import ${clause.isTypeOnly ? "type " : ""}{ ${binding.getText(ast)} } from ${JSON.stringify(target)};`;
        })
        .join("\n");
      edits.push([node.getStart(ast), node.end, replacement]);
    }
    let output = source;
    for (const [start, end, replacement] of edits.reverse())
      output = output.slice(0, start) + replacement + output.slice(end);
    sources.set(name, output);
  }
  return sources;
}

// Upstream uses three unmarked type-only re-exports. Its whole-program
// bundler erases those; isolated TS transpilation needs that same information.
// Derive it from declarations rather than maintaining a hand-written name list.
export function markTypeOnlyReexports(name, source, sources) {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const insertions = [];
  for (const node of ast.statements) {
    if (
      !ts.isExportDeclaration(node) ||
      node.isTypeOnly ||
      !node.moduleSpecifier ||
      !node.exportClause ||
      !ts.isNamedExports(node.exportClause)
    )
      continue;
    const target = path.posix
      .normalize(path.posix.join(path.posix.dirname(name), node.moduleSpecifier.text))
      .replace(/\.js$/, ".ts");
    if (!sources.has(target)) continue;
    const declarations = ts.createSourceFile(
      target,
      sources.get(target),
      ts.ScriptTarget.Latest,
      true,
    );
    const types = new Set();
    const values = new Set();
    for (const declaration of declarations.statements) {
      if (
        (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) &&
        declaration.name
      )
        types.add(declaration.name.text);
      else if (ts.isVariableStatement(declaration)) {
        for (const variable of declaration.declarationList.declarations) {
          if (ts.isIdentifier(variable.name)) values.add(variable.name.text);
        }
      } else if (declaration.name && ts.isIdentifier(declaration.name))
        values.add(declaration.name.text);
    }
    for (const binding of node.exportClause.elements) {
      const imported = binding.propertyName?.text ?? binding.name.text;
      if (!binding.isTypeOnly && types.has(imported) && !values.has(imported))
        insertions.push(binding.getStart(ast));
    }
  }
  let result = source;
  for (const index of insertions.reverse())
    result = result.slice(0, index) + "type " + result.slice(index);
  return result;
}

/** Build-only adaptation; dev continues using the published parser unchanged. */
export function mermaidParserPlugin() {
  let root;
  let parserEntry;
  let sources;
  return {
    name: "cowork-modular-mermaid-parser",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    async buildStart() {
      const from = path.join(root, "package.json");
      const mermaid = await this.resolve("mermaid", from, { skipSelf: true });
      invariant(mermaid && !mermaid.external, "cannot resolve installed Mermaid");
      const parser = await this.resolve("@mermaid-js/parser", mermaid.id, { skipSelf: true });
      const langium = await this.resolve("langium", from, { skipSelf: true });
      invariant(
        parser && !parser.external && langium && !langium.external,
        "cannot resolve parser/Langium dependencies",
      );
      parserEntry = parser.id;
      const result = loadMermaidParserSources({
        parserEntry,
        mermaidEntry: mermaid.id,
        langiumEntry: langium.id,
      });
      sources = result.sources;
      result.watchFiles.forEach((file) => this.addWatchFile(file));
    },
    async resolveId(source, importer) {
      if (source === "@mermaid-js/parser") {
        const actual = await this.resolve(source, importer, { skipSelf: true });
        invariant(
          actual?.id === parserEntry,
          "Mermaid imports a different parser package instance",
        );
        return { id: `${prefix}src/index.ts`, moduleSideEffects: false };
      }
      if (!importer?.startsWith(prefix)) return null;
      if (!source.startsWith("."))
        return this.resolve(source, path.join(root, "package.json"), { skipSelf: true });
      const name = path.posix
        .normalize(path.posix.join(path.posix.dirname(importer.slice(prefix.length)), source))
        .replace(/\.js$/, ".ts");
      invariant(sources.has(name), `unmapped import ${source} from ${importer}`);
      return {
        id: `${prefix}${name}`,
        ...(Object.hasOwn(barrels, name) ? { moduleSideEffects: false } : {}),
      };
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "assets/mermaid-parser-LICENSE.txt",
        source: readFileSync(path.join(directory, "LICENSE"), "utf8"),
      });
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      const name = id.slice(prefix.length);
      invariant(sources.has(name), `unknown virtual source ${name}`);
      const result = ts.transpileModule(markTypeOnlyReexports(name, sources.get(name), sources), {
        fileName: name,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
          inlineSources: true,
        },
      });
      const map = JSON.parse(result.sourceMapText);
      map.sources = [`mermaid-parser://${name}`];
      return {
        code: `/*! @mermaid-js/parser 2.0.1, Copyright (c) 2023 Yokozuna59, MIT. */\n${result.outputText}`,
        map,
      };
    },
  };
}
