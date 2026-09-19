#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  collectVaultMarkdownFiles,
  getTitleFromMarkdown,
  normalizeRelativePath,
  parseFrontmatter,
  readText,
  stripHtml,
} from "./wiki-workbench-lib.mjs";

const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

function parseArgs(argv) {
  const args = {
    format: "markdown",
    limit: 8,
    scope: "all",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--vault") {
      args.vault = argv[++i];
      continue;
    }
    if (token === "--query") {
      args.query = argv[++i];
      continue;
    }
    if (token === "--limit") {
      args.limit = Number(argv[++i]);
      continue;
    }
    if (token === "--format") {
      args.format = argv[++i];
      continue;
    }
    if (token === "--scope") {
      args.scope = argv[++i];
      continue;
    }
  }
  if (!args.vault) throw new Error("Missing --vault <path>");
  if (!args.query) throw new Error("Missing --query <text>");
  if (!["markdown", "json"].includes(args.format)) {
    throw new Error("Invalid --format. Use markdown or json.");
  }
  if (!["wiki", "raw", "all"].includes(args.scope)) {
    throw new Error("Invalid --scope. Use wiki, raw, or all.");
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    args.limit = 8;
  }
  return args;
}

function tokenize(value) {
  return Array.from(
    new Set(
      String(value || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index >= 0) {
    index = haystack.indexOf(needle, index);
    if (index < 0) break;
    count += 1;
    index += needle.length;
  }
  return count;
}

function extractSnippet(text, terms) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  let firstHit = -1;
  for (const term of terms) {
    const hit = normalized.toLowerCase().indexOf(term);
    if (hit >= 0 && (firstHit < 0 || hit < firstHit)) {
      firstHit = hit;
    }
  }
  if (firstHit < 0) {
    return normalized.slice(0, 220);
  }
  const start = Math.max(0, firstHit - 80);
  const end = Math.min(normalized.length, firstHit + 160);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function buildInboundCounts(files) {
  const inbound = new Map();
  const pageBySlug = new Map();
  for (const file of files) {
    const relPath = normalizeRelativePath(file.relPath);
    if (relPath.endsWith(".md")) {
      const slug = relPath.replace(/\.md$/i, "").toLowerCase();
      pageBySlug.set(slug, file);
      pageBySlug.set(path.basename(slug), file);
    }
  }

  for (const file of files) {
    for (const match of file.rawText.matchAll(WIKILINK_RE)) {
      const linkTarget = String(match[1] || "")
        .split("|")[0]
        .split("#")[0]
        .trim()
        .replace(/\\/g, "/")
        .replace(/\.md$/i, "")
        .toLowerCase();
      if (!linkTarget) continue;
      const target = pageBySlug.get(linkTarget) || pageBySlug.get(path.basename(linkTarget));
      if (!target) continue;
      inbound.set(target.relPath, (inbound.get(target.relPath) || 0) + 1);
    }
  }
  return inbound;
}

function collectFiles(vaultPath, scope) {
  const candidates = collectVaultMarkdownFiles(vaultPath, scope);
  return candidates.map((filePath) => {
    const rawText = readText(filePath);
    const parsed = parseFrontmatter(rawText);
    const relPath = normalizeRelativePath(path.relative(vaultPath, filePath));
    const title = getTitleFromMarkdown(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const bodyText =
      ext === ".html" || ext === ".htm" ? stripHtml(rawText) : parsed.body || rawText;
    return {
      filePath,
      relPath,
      title,
      rawText,
      bodyText,
      frontmatter: parsed.fields,
      mtimeMs: fs.statSync(filePath).mtimeMs,
    };
  });
}

function rankFiles(files, query) {
  const terms = tokenize(query);
  const inboundCounts = buildInboundCounts(files);
  const ranked = [];

  for (const file of files) {
    const title = String(file.title || "").toLowerCase();
    const relPath = file.relPath.toLowerCase();
    const tagText = Array.isArray(file.frontmatter.tags)
      ? file.frontmatter.tags.join(" ").toLowerCase()
      : String(file.frontmatter.tags || "").toLowerCase();
    const bodyText = String(file.bodyText || "").toLowerCase();
    let score = 0;

    for (const term of terms) {
      score += countOccurrences(title, term) * 8;
      score += countOccurrences(relPath, term) * 5;
      score += countOccurrences(tagText, term) * 3;
      score += Math.min(12, countOccurrences(bodyText, term));
    }

    score += Math.min(5, inboundCounts.get(file.relPath) || 0) * 0.5;
    if (score <= 0) continue;

    ranked.push({
      path: file.relPath,
      title: file.title,
      score: Number(score.toFixed(2)),
      inboundLinks: inboundCounts.get(file.relPath) || 0,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      snippet: extractSnippet(file.bodyText, terms),
      sourceType: file.relPath.startsWith("raw/") ? "raw" : "wiki",
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });
  return ranked;
}

function formatMarkdown(query, results, vaultPath) {
  const lines = [
    `# Vault Search`,
    ``,
    `- Vault: \`${vaultPath}\``,
    `- Query: \`${query}\``,
    `- Matches: ${results.length}`,
    ``,
  ];
  if (results.length === 0) {
    lines.push(`No matches found.`);
    return `${lines.join("\n")}\n`;
  }
  for (const result of results) {
    lines.push(`## ${result.title}`);
    lines.push(`- Path: \`${result.path}\``);
    lines.push(`- Score: ${result.score}`);
    lines.push(`- Source type: ${result.sourceType}`);
    lines.push(`- Inbound links: ${result.inboundLinks}`);
    lines.push(`- Updated: ${result.updatedAt}`);
    if (result.snippet) {
      lines.push(`- Snippet: ${result.snippet}`);
    }
    lines.push(``);
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const vaultPath = path.resolve(args.vault);
  const files = collectFiles(vaultPath, args.scope);
  const results = rankFiles(files, args.query).slice(0, args.limit);
  const payload = {
    query: args.query,
    vaultPath,
    scope: args.scope,
    results,
  };

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatMarkdown(args.query, results, vaultPath));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
