#!/usr/bin/env node
// Static inventory of synchronous SQLite access for the async SQLite migration
// (DB0 in docs/async-sqlite-migration-plan-2026-09-27.md).
//
// Counts are text-search counts over non-test TypeScript under src/, with
// comments removed. They locate call sites; they are not a call graph.
//
// Usage:
//   node scripts/qa/sqlite-inventory.mjs                 # markdown report
//   node scripts/qa/sqlite-inventory.mjs --json out.json # also write JSON
//   node scripts/qa/sqlite-inventory.mjs --top 30 --root src
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PATTERNS = {
  prepare: /\.prepare\(/g,
  exec: /\b(?:db|database|sqlite|connection|getDatabase\(\))\s*\.exec\(/g,
  pragma: /\.pragma\(/g,
  transaction: /\.transaction\(/g,
  immediate: /\.immediate\(\)|["'`]BEGIN IMMEDIATE\b/g,
  getDatabase: /\bgetDatabase\(\)/g,
  newDatabase: /\bnew Database\(/g,
  repositoryConstruction: /\bnew [A-Z][\w$]*Repository\(/g,
  runtimeImport:
    /^import\s+(?!type\b)[^;]*?from\s+["']better-sqlite3["']|require\(\s*["']better-sqlite3["']\s*\)|import\(\s*["']better-sqlite3["']\s*\)/gm,
  typeImport: /^import\s+type\s[^;]*?from\s+["']better-sqlite3["']/gm,
};

export const COUNT_KEYS = Object.keys(PATTERNS);

const DECLARATION_PATTERNS = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  // Class members: `name(args): Type {` on one line, or a multi-line signature opener `name(`.
  /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\((?:(?:[^()]|\([^()]*\))*\)(?:\s*:.*)?\s*\{|(?:(?!=>)[^()]|\([^()]*\))*)\s*$/,
];
const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function"]);

/** Replace comments with spaces, keeping line numbers and string contents. */
export function stripComments(source) {
  let out = "";
  let state = "code";
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 1;
      } else if (char === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 1;
      } else {
        if (char === '"' || char === "'" || char === "`") {
          state = "string";
          quote = char;
        }
        out += char;
      }
    } else if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      } else {
        out += " ";
      }
    } else if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 1;
      } else {
        out += char === "\n" ? "\n" : " ";
      }
    } else {
      if (char === "\\") {
        out += char + (next ?? "");
        i += 1;
        continue;
      }
      if (char === quote) state = "code";
      out += char;
    }
  }
  return out;
}

function emptyCounts() {
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function matchDeclaration(line) {
  for (const pattern of DECLARATION_PATTERNS) {
    const name = pattern.exec(line)?.[1];
    if (name && !CONTROL_KEYWORDS.has(name)) return name;
  }
  return "";
}

/**
 * Best-effort `Class.member` that contains `lineIndex` (0-based), found by
 * walking up through less-indented lines. Returns "(module)" at top level.
 */
export function findEnclosingName(lines, lineIndex) {
  let limit = indentation(lines[lineIndex] ?? "");
  let signatureIndent = -1;
  let memberName = "";
  for (let i = lineIndex - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = indentation(line);
    if (signatureIndent >= 0) {
      // Inside a multi-line parameter list: find the line that opened it.
      if (indent !== signatureIndent) continue;
      signatureIndent = -1;
    } else if (indent >= limit) {
      continue;
    }
    limit = indent;
    const className = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1];
    if (className) return memberName ? `${className}.${memberName}` : className;
    if (memberName) continue;
    // `}): Type {` or `} {` closes a multi-line signature or return type.
    if (/^[)}]/.test(line.trimStart())) {
      signatureIndent = indent;
      continue;
    }
    memberName = matchDeclaration(line);
  }
  return memberName || "(module)";
}

/** Count SQLite access patterns in one file and list its transaction sites. */
export function scanSource(path, source) {
  const text = stripComments(source);
  const counts = emptyCounts();
  for (const key of COUNT_KEYS) {
    counts[key] = (text.match(PATTERNS[key]) ?? []).length;
  }
  const lines = text.split("\n");
  const transactions = [];
  for (const match of text.matchAll(PATTERNS.transaction)) {
    const line = lineNumberAt(text, match.index);
    transactions.push({ path, line, enclosing: findEnclosingName(lines, line - 1) });
  }
  return { path, counts, transactions };
}

function isInventorySource(path) {
  return (
    /\.tsx?$/.test(path) &&
    !path.endsWith(".d.ts") &&
    !/\.test\.tsx?$/.test(path) &&
    !path.split(/[/\\]/).includes("__tests__")
  );
}

function listFiles(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "__tests__" ? [] : listFiles(path);
    }
    return entry.isFile() && isInventorySource(path) ? [path] : [];
  });
}

function addCounts(target, counts) {
  for (const key of COUNT_KEYS) target[key] += counts[key];
}

function hasAccess(counts) {
  return COUNT_KEYS.some((key) => counts[key] > 0);
}

function directoryOf(path) {
  const parts = path.split("/");
  // Group src/electron/<area> and src/<area>.
  return parts[1] === "electron" ? parts.slice(0, 3).join("/") : parts.slice(0, 2).join("/");
}

function readGitRevision(cwd) {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

export function buildInventory({ cwd = process.cwd(), root = "src" } = {}) {
  const rootPath = resolve(cwd, root);
  const files = [];
  const transactions = [];
  const totals = { files: 0, ...emptyCounts() };
  const directories = new Map();
  for (const absolute of listFiles(rootPath).sort()) {
    const path = relative(cwd, absolute).split(sep).join("/");
    const scan = scanSource(path, readFileSync(absolute, "utf8"));
    if (!hasAccess(scan.counts)) continue;
    files.push({ path, counts: scan.counts });
    transactions.push(...scan.transactions);
    totals.files += 1;
    addCounts(totals, scan.counts);
    const directory = directoryOf(path);
    const bucket = directories.get(directory) ?? { directory, files: 0, ...emptyCounts() };
    bucket.files += 1;
    addCounts(bucket, scan.counts);
    directories.set(directory, bucket);
  }
  return {
    generatedAt: new Date().toISOString(),
    revision: readGitRevision(cwd),
    root,
    method: "text search over non-test TypeScript with comments removed",
    totals,
    directories: Array.from(directories.values()).sort((a, b) => b.prepare - a.prepare),
    files: files.sort((a, b) => b.counts.prepare - a.counts.prepare),
    transactions,
  };
}

const HEADERS = {
  prepare: "prepare",
  exec: "exec",
  pragma: "pragma",
  transaction: "txn",
  immediate: "immediate",
  getDatabase: "getDatabase",
  newDatabase: "new Database",
  repositoryConstruction: "new *Repository",
  runtimeImport: "runtime import",
  typeImport: "type import",
};

function row(cells) {
  return `| ${cells.join(" | ")} |`;
}

export function renderMarkdown(inventory, { top = 20 } = {}) {
  const lines = [];
  const { revision, totals } = inventory;
  lines.push("# SQLite access inventory", "");
  lines.push(
    `Generated ${inventory.generatedAt} at ${revision.sha ?? "unknown revision"}${revision.dirty ? " (dirty tree)" : ""}. ${inventory.method}.`,
    "",
  );
  lines.push("## Totals", "");
  lines.push(row(["files", ...COUNT_KEYS.map((key) => HEADERS[key])]));
  lines.push(row(Array(COUNT_KEYS.length + 1).fill("---")));
  lines.push(row([totals.files, ...COUNT_KEYS.map((key) => totals[key])]));
  lines.push("", "## By area", "");
  lines.push(row(["area", "files", ...COUNT_KEYS.map((key) => HEADERS[key])]));
  lines.push(row(Array(COUNT_KEYS.length + 2).fill("---")));
  for (const bucket of inventory.directories) {
    lines.push(
      row([`\`${bucket.directory}\``, bucket.files, ...COUNT_KEYS.map((key) => bucket[key])]),
    );
  }
  lines.push("", `## Top ${top} files by prepare()`, "");
  lines.push(row(["file", ...COUNT_KEYS.map((key) => HEADERS[key])]));
  lines.push(row(Array(COUNT_KEYS.length + 1).fill("---")));
  for (const file of inventory.files.slice(0, top)) {
    lines.push(row([`\`${file.path}\``, ...COUNT_KEYS.map((key) => file.counts[key])]));
  }
  lines.push("", `## Transaction sites (${inventory.transactions.length})`, "");
  lines.push(row(["site", "enclosing"]));
  lines.push(row(["---", "---"]));
  for (const site of inventory.transactions) {
    lines.push(row([`\`${site.path}:${site.line}\``, `\`${site.enclosing}\``]));
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = { json: null, root: "src", top: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const separator = argv[i].indexOf("=");
    const flag = separator < 0 ? argv[i] : argv[i].slice(0, separator);
    const inline = separator < 0 ? undefined : argv[i].slice(separator + 1);
    const value = () => inline ?? argv[++i];
    if (flag === "--json") options.json = value();
    else if (flag === "--root") options.root = value();
    else if (flag === "--top") options.top = Number(value());
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const inventory = buildInventory({ root: options.root });
  if (options.json) {
    mkdirSync(dirname(resolve(options.json)), { recursive: true });
    writeFileSync(options.json, `${JSON.stringify(inventory, null, 2)}\n`);
  }
  process.stdout.write(renderMarkdown(inventory, { top: options.top }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
