import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * React needs every hook to run on every render. A hook placed after an early return
 * (for example `if (loading) return <Spinner />;`) is skipped on the first render and
 * runs on a later one, and React then throws "Rendered more hooks than during the
 * previous render", taking the whole window down. The lint setup does not catch this
 * pattern, so this test scans renderer components and custom hooks for it.
 */

const RENDERER_ROOTS = ["../", "../../renderer-web/"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry) && !/\.(test|d)\.tsx?$/.test(entry)) files.push(path);
  }
  return files;
}

const isHookName = (name: string) => /^use[A-Z0-9]/.test(name);

/** Hook calls in a statement, ignoring nested functions (callbacks may call hooks freely). */
function hookCallsIn(node: ts.Node): string[] {
  const found: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isCallExpression(child)) {
      const callee = child.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (isHookName(name)) found.push(name);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Whether a statement can return from the function it sits in. */
function canReturn(node: ts.Node): boolean {
  if (ts.isReturnStatement(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  let result = false;
  ts.forEachChild(node, (child) => {
    if (!result && canReturn(child)) result = true;
  });
  return result;
}

interface Violation {
  file: string;
  line: number;
  owner: string;
  hook: string;
}

function checkBody(
  owner: string,
  body: ts.Block,
  sourceFile: ts.SourceFile,
  file: string,
  out: Violation[],
) {
  let returned = false;
  for (const statement of body.statements) {
    if (returned) {
      for (const hook of hookCallsIn(statement)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart());
        out.push({ file, line: line + 1, owner, hook });
      }
    }
    if (!returned && canReturn(statement)) returned = true;
  }
}

function scan(file: string): Violation[] {
  const text = readFileSync(file, "utf8");
  if (!/\buse[A-Z]/.test(text)) return [];
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Violation[] = [];
  const visit = (node: ts.Node) => {
    let name = "";
    let body: ts.ConciseBody | undefined;
    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
      body = node.body;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      name = node.name.text;
      body = node.initializer.body;
    } else if (ts.isFunctionExpression(node) && node.name) {
      // memo(function Name() {...}) and forwardRef(function Name() {...})
      name = node.name.text;
      body = node.body;
    }
    const isComponentOrHook = /^[A-Z]/.test(name) || isHookName(name);
    if (isComponentOrHook && body && ts.isBlock(body)) {
      checkBody(name, body, sourceFile, relative(REPO_ROOT, file), out);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

describe("hooks after an early return", () => {
  it("never calls a hook after a component or hook may already have returned", () => {
    const violations = RENDERER_ROOTS.flatMap((root) => sourceFiles(root)).flatMap(scan);
    expect(
      violations.map(({ file, line, owner, hook }) => `${file}:${line} ${owner} calls ${hook}`),
    ).toEqual([]);
  });

  it("flags the pattern", () => {
    const file = "Example.tsx";
    const sourceFile = ts.createSourceFile(
      file,
      `function Example({ loading }) {
         const [a] = useState(0);
         if (loading) return null;
         useEffect(() => {});
         const onClick = () => useCallbackLike();
         return a;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const out: Violation[] = [];
    const fn = sourceFile.statements[0] as ts.FunctionDeclaration;
    checkBody("Example", fn.body!, sourceFile, file, out);
    expect(out.map((v) => v.hook)).toEqual(["useEffect"]);
  });
});
