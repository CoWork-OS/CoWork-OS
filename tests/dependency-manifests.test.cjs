const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function sourceFiles(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "__tests__"].includes(entry.name)) return [];
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\.[jt]sx?$/.test(file) ? [file] : [];
  });
}

function imports(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const result = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") {
        result.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

function packageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/") || specifier.startsWith("@shared/")) return null;
  if (specifier.startsWith("node:") || builtins.has(specifier)) return null;
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

test("production package imports have explicit runtime ownership", () => {
  const manifest = readJson(path.join(root, "package.json"));
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }));
  const missing = new Set();
  for (const file of sourceFiles(path.join(root, "src"))) {
    for (const specifier of imports(file)) {
      const name = packageName(specifier);
      if (name && !declared.has(name)) missing.add(`${name} in ${path.relative(root, file)}`);
    }
  }
  assert.deepEqual([...missing].sort(), []);
});

test("standalone connector builds declare the Node types used by their source", () => {
  const missing = [];
  const connectorRoot = path.join(root, "connectors");
  const manifests = [
    ...fs.readdirSync(connectorRoot).map((name) => path.join(connectorRoot, name, "package.json")),
    path.join(connectorRoot, "templates", "mcp-connector", "package.json"),
  ].filter(fs.existsSync);
  for (const file of manifests) {
    const manifest = readJson(file);
    const files = sourceFiles(path.join(path.dirname(file), "src"));
    if (files.some((source) => imports(source).some((name) => name.startsWith("node:") || builtins.has(name)))) {
      const declared = { ...manifest.dependencies, ...manifest.devDependencies };
      if (!declared["@types/node"]) missing.push(path.relative(root, file));
    }
  }
  assert.deepEqual(missing, []);
});

test("the ESLint configuration owns and loads its imported preset", async () => {
  const manifest = readJson(path.join(root, "package.json"));
  assert.ok(manifest.devDependencies["@eslint/js"]);
  assert.ok(Array.isArray((await import("../eslint.config.js")).default));
});

test("checked-in npm locks agree with their owning manifests", () => {
  for (const folder of [".", "connectors/figma-mcp", "connectors/monday-mcp", "connectors/vercel-mcp"]) {
    const manifest = readJson(path.join(root, folder, "package.json"));
    const locked = readJson(path.join(root, folder, "package-lock.json")).packages[""];
    for (const field of ["name", "version", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      assert.deepEqual(locked[field], manifest[field], `${folder}: ${field}`);
    }
  }
});
