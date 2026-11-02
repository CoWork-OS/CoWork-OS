#!/usr/bin/env node
/**
 * Fail on broken relative Markdown links and images in the user-facing docs:
 * README.md, CONTRIBUTING.md and docs/**.
 *
 * Dependency-free like the other scripts/qa checks. Every relative link target
 * must exist in the repository (case-sensitively) and, when the link carries a
 * `#fragment`, the target must contain a heading that slugs to it. Links that
 * intentionally point outside what can be verified live in ALLOWLIST with a
 * reason; anything else fails the run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";

/** Markdown link/image targets that are intentionally unverifiable. Keep short, justify each. */
const ALLOWLIST = [
  // Rendered by the docs site from frontmatter, not a file on disk.
  { pattern: /^\/CoWork-OS\/$/, reason: "docs-site root link emitted by VitePress" },
  // Anchors to tabs created at runtime; no markdown heading can match them.
  { pattern: /^#terminal\//, reason: "runtime terminal-tab anchors" },
];

/** Files whose historical content is allowed to reference archived paths. */
const HISTORICAL = /(^|\/)(changelog\.md|release-notes-[^/]+\.md)$/i;

const LINK = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function listMarkdownFiles() {
  let paths;
  try {
    paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).split("\0");
  } catch {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
        const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
        return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
      });
    paths = walk(".");
  }
  return paths.filter((p) => /^\.md$/i.test(p.slice(-3)) || p.endsWith(".md"));
}

/** GitHub-style heading slug, computed the way anchors are rendered. */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~\[\]]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

export function headingsOf(source) {
  const slugs = new Set();
  let fenced = false;
  for (const line of source.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading) slugs.add(slugify(heading[1]));
  }
  return slugs;
}

export function checkFile(path, source, repoRoot) {
  const errors = [];
  if (HISTORICAL.test(path)) return errors;
  const dir = dirname(path);
  let fenced = false;
  for (const [index, line] of source.split("\n").entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const [, , target] of line.matchAll(LINK)) {
      const cleaned = target.replace(/[.,;:)]+$/, "");
      if (/^(https?:|mailto:)/i.test(cleaned)) continue;
      if (ALLOWLIST.some(({ pattern }) => pattern.test(cleaned))) continue;
      const [rawPath, fragment] = cleaned.split("#", 2);
      if (!rawPath) {
        // Same-page anchor.
        if (fragment && !headingsOf(source).has(slugify(decodeURIComponent(fragment)))) {
          errors.push(`${path}:${index + 1}: anchor #${fragment} matches no heading`);
        }
        continue;
      }
      if (rawPath.startsWith("/")) {
        errors.push(
          `${path}:${index + 1}: absolute link ${cleaned} skips the base path; use a repo-relative link`,
        );
        continue;
      }
      const decoded = decodeURIComponent(rawPath);
      const resolved = resolve(repoRoot, posix.normalize(join(dir, decoded).split(sep).join("/")));
      const relative = resolve(repoRoot, ".", resolved).slice(repoRoot.length + 1);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        errors.push(`${path}:${index + 1}: broken link -> ${cleaned}`);
        continue;
      }
      if (fragment && /\.md$/i.test(relative)) {
        const targetSource = readFileSync(resolved, "utf8");
        if (!headingsOf(targetSource).has(slugify(decodeURIComponent(fragment)))) {
          errors.push(`${path}:${index + 1}: ${cleaned} matches no heading in ${relative}`);
        }
      }
    }
  }
  return errors;
}

export function main() {
  const repoRoot = process.cwd();
  const errors = [];
  for (const path of listMarkdownFiles()) {
    const inScope =
      path === "README.md" ||
      path === "CONTRIBUTING.md" ||
      path === "docs/getting-started.md".replace("x", "x") ||
      /^docs\/.+\.md$/i.test(path) ||
      /^docs\/[^/]+\.md$/i.test(path);
    if (!inScope) continue;
    errors.push(...checkFile(path, readFileSync(path, "utf8"), repoRoot));
  }
  if (errors.length) {
    console.error(`docs link check failed with ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log("docs link check passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
