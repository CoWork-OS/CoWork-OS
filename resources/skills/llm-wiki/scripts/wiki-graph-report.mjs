#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const CONTENT_DIRS = ["entities", "concepts", "projects", "comparisons", "queries", "maps", "_meta"];
const REQUIRED_FRONTMATTER_FIELDS = ["title", "created", "updated", "type", "tags", "status", "sources"];
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

function parseArgs(argv) {
  const args = { format: "markdown" };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--vault") {
      args.vault = argv[++i];
      continue;
    }
    if (token === "--format") {
      args.format = argv[++i];
      continue;
    }
  }
  if (!args.vault) {
    throw new Error("Missing --vault <path>");
  }
  if (!["markdown", "json"].includes(args.format)) {
    throw new Error("Invalid --format. Use markdown or json.");
  }
  return args;
}

function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      output.push(fullPath);
    }
  }
  return output;
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
}

function slugifyTarget(rawTarget) {
  const target = String(rawTarget || "")
    .split("|")[0]
    .split("#")[0]
    .trim();
  if (!target) return "";
  return target
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-"),
    )
    .join("/");
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { fields: null, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { fields: null, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(end + 5);
  const fields = {};
  let currentKey = null;
  for (const line of raw.split("\n")) {
    if (/^\s*-\s+/.test(line) && currentKey) {
      if (!Array.isArray(fields[currentKey])) fields[currentKey] = [];
      fields[currentKey].push(line.replace(/^\s*-\s+/, "").trim());
      continue;
    }
    const match = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    currentKey = key;
    if (value === "") {
      fields[key] = [];
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      fields[key] = value
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      continue;
    }
    fields[key] = value.trim();
  }
  return { fields, body };
}

function extractWikiLinks(text) {
  const links = [];
  for (const match of text.matchAll(WIKILINK_RE)) {
    const raw = String(match[1] || "").trim();
    const slug = slugifyTarget(raw);
    if (slug) {
      links.push({ raw, slug });
    }
  }
  return links;
}

function getPageTitle(page) {
  return String(page.frontmatter?.title || path.basename(page.relPath, ".md"));
}

function getPageSection(relPath) {
  return String(relPath || "").split("/")[0] || "_root";
}

function resolveLinkTarget(linkSlug, pageBySlug, pagesByBasename) {
  const exact = pageBySlug.get(linkSlug) || null;
  if (exact) {
    return { kind: "resolved", page: exact };
  }

  const basename = path.basename(linkSlug);
  const basenameMatches = pagesByBasename.get(basename) || [];
  if (basenameMatches.length === 1) {
    return { kind: "resolved", page: basenameMatches[0] };
  }
  if (basenameMatches.length > 1) {
    return { kind: "ambiguous", candidates: basenameMatches.map((page) => page.relPath) };
  }

  return { kind: "missing" };
}

function computeBetweennessCentrality(adjacency) {
  const nodes = Array.from(adjacency.keys());
  const scores = new Map(nodes.map((node) => [node, 0]));
  for (const source of nodes) {
    const stack = [];
    const predecessors = new Map(nodes.map((node) => [node, []]));
    const pathCounts = new Map(nodes.map((node) => [node, 0]));
    const distance = new Map(nodes.map((node) => [node, -1]));
    pathCounts.set(source, 1);
    distance.set(source, 0);

    const queue = [source];
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      stack.push(node);
      for (const neighbor of adjacency.get(node) || []) {
        if (distance.get(neighbor) === -1) {
          queue.push(neighbor);
          distance.set(neighbor, (distance.get(node) || 0) + 1);
        }
        if (distance.get(neighbor) === (distance.get(node) || 0) + 1) {
          pathCounts.set(neighbor, (pathCounts.get(neighbor) || 0) + (pathCounts.get(node) || 0));
          predecessors.get(neighbor)?.push(node);
        }
      }
    }

    const dependency = new Map(nodes.map((node) => [node, 0]));
    while (stack.length > 0) {
      const node = stack.pop();
      const sigma = pathCounts.get(node) || 0;
      if (!node || sigma === 0) continue;
      for (const predecessor of predecessors.get(node) || []) {
        const predecessorPaths = pathCounts.get(predecessor) || 0;
        const contribution = (predecessorPaths / sigma) * (1 + (dependency.get(node) || 0));
        dependency.set(predecessor, (dependency.get(predecessor) || 0) + contribution);
      }
      if (node !== source) {
        scores.set(node, (scores.get(node) || 0) + (dependency.get(node) || 0));
      }
    }
  }

  for (const node of nodes) {
    scores.set(node, (scores.get(node) || 0) / 2);
  }
  return scores;
}

function buildPageRecords(vaultPath) {
  const pages = [];
  for (const dirName of CONTENT_DIRS) {
    const dirPath = path.join(vaultPath, dirName);
    const files = listFilesRecursive(dirPath).filter((filePath) => filePath.endsWith(".md"));
    for (const filePath of files) {
      const relPath = path.relative(vaultPath, filePath).replace(/\\/g, "/");
      const slug = relPath.replace(/\.md$/i, "").toLowerCase();
      const basenameSlug = path.basename(filePath, ".md").toLowerCase();
      const text = readText(filePath);
      const { fields } = parseFrontmatter(text);
      pages.push({
        filePath,
        relPath,
        slug,
        basenameSlug,
        text,
        frontmatter: fields,
        links: extractWikiLinks(text),
      });
    }
  }
  return pages;
}

function buildReport(vaultPath) {
  const pages = buildPageRecords(vaultPath);
  const pageBySlug = new Map();
  const pagesByBasename = new Map();
  for (const page of pages) {
    pageBySlug.set(page.slug, page);
    const existing = pagesByBasename.get(page.basenameSlug) || [];
    existing.push(page);
    pagesByBasename.set(page.basenameSlug, existing);
  }

  const inbound = new Map();
  const brokenLinks = [];
  const ambiguousLinks = [];
  const weakOutbound = [];
  const adjacency = new Map(pages.map((page) => [page.relPath, new Set()]));
  const resolvedEdges = new Map();
  let totalLinks = 0;
  const uniqueTargets = new Set();

  for (const page of pages) {
    const distinctResolvedTargets = new Set();
    const distinctResolvedTargetsByPage = new Map();
    for (const link of page.links) {
      totalLinks += 1;
      uniqueTargets.add(link.slug);
      const resolution = resolveLinkTarget(link.slug, pageBySlug, pagesByBasename);
      if (resolution.kind === "missing") {
        brokenLinks.push({
          source: page.relPath,
          target: link.raw,
        });
        continue;
      }
      if (resolution.kind === "ambiguous") {
        ambiguousLinks.push({
          source: page.relPath,
          target: link.raw,
          candidates: resolution.candidates,
        });
        continue;
      }
      distinctResolvedTargets.add(resolution.page.relPath);
      if (!distinctResolvedTargetsByPage.has(resolution.page.relPath)) {
        distinctResolvedTargetsByPage.set(resolution.page.relPath, {
          source: page.relPath,
          sourceTitle: getPageTitle(page),
          sourceSection: getPageSection(page.relPath),
          target: resolution.page.relPath,
          targetTitle: getPageTitle(resolution.page),
          targetSection: getPageSection(resolution.page.relPath),
        });
      }
      inbound.set(resolution.page.relPath, (inbound.get(resolution.page.relPath) || 0) + 1);
    }
    for (const [targetRelPath, edge] of distinctResolvedTargetsByPage.entries()) {
      adjacency.get(page.relPath)?.add(targetRelPath);
      adjacency.get(targetRelPath)?.add(page.relPath);
      const pairKey = [page.relPath, targetRelPath].sort().join("::");
      if (!resolvedEdges.has(pairKey)) {
        resolvedEdges.set(pairKey, edge);
      }
    }
    if (distinctResolvedTargets.size < 2) {
      weakOutbound.push(page.relPath);
    }
  }

  const betweenness = computeBetweennessCentrality(adjacency);
  const bridgePages = pages
    .map((page) => {
      const neighbors = Array.from(adjacency.get(page.relPath) || []);
      const connectedSections = Array.from(
        new Set(neighbors.map((neighbor) => getPageSection(neighbor)).filter(Boolean)),
      );
      return {
        page: page.relPath,
        title: getPageTitle(page),
        betweenness: Number((betweenness.get(page.relPath) || 0).toFixed(3)),
        degree: neighbors.length,
        sectionsConnected: connectedSections.length,
        connectedSections,
      };
    })
    .filter((page) => page.betweenness > 0)
    .sort(
      (a, b) =>
        b.betweenness - a.betweenness ||
        b.degree - a.degree ||
        a.page.localeCompare(b.page),
    )
    .slice(0, 5);

  const crossSectionCandidates = Array.from(resolvedEdges.values())
    .filter((edge) => edge.sourceSection !== edge.targetSection)
    .map((edge) => {
      const sourceBridge = betweenness.get(edge.source) || 0;
      const targetBridge = betweenness.get(edge.target) || 0;
      const score = sourceBridge + targetBridge;
      const reasons = [`bridges ${edge.sourceSection} -> ${edge.targetSection}`];
      if (sourceBridge > 0 || targetBridge > 0) {
        const bridgeSide = sourceBridge >= targetBridge ? edge.sourceTitle : edge.targetTitle;
        reasons.push(`passes through bridge page [[${bridgeSide}]]`);
      }
      return {
        ...edge,
        score,
        note: reasons.join("; "),
        sectionPair: [edge.sourceSection, edge.targetSection].sort().join("::"),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target),
    );

  const surprisingConnections = [];
  const seenSectionPairs = new Set();
  for (const candidate of crossSectionCandidates) {
    if (seenSectionPairs.has(candidate.sectionPair)) {
      continue;
    }
    seenSectionPairs.add(candidate.sectionPair);
    surprisingConnections.push({
      source: candidate.source,
      sourceTitle: candidate.sourceTitle,
      sourceSection: candidate.sourceSection,
      target: candidate.target,
      targetTitle: candidate.targetTitle,
      targetSection: candidate.targetSection,
      note: candidate.note,
    });
    if (surprisingConnections.length >= 5) {
      break;
    }
  }

  const orphans = pages
    .filter((page) => (inbound.get(page.relPath) || 0) === 0)
    .map((page) => page.relPath);

  const frontmatterIssues = [];
  for (const page of pages) {
    const missing = REQUIRED_FRONTMATTER_FIELDS.filter((field) => {
      const value = page.frontmatter?.[field];
      if (Array.isArray(value)) return value.length === 0;
      return typeof value !== "string" || value.trim().length === 0;
    });
    if (missing.length > 0) {
      frontmatterIssues.push({
        page: page.relPath,
        missing,
      });
    }
  }

  const rawDir = path.join(vaultPath, "raw");
  const rawSources = fs.existsSync(rawDir)
    ? listFilesRecursive(rawDir).filter((filePath) => fs.statSync(filePath).isFile()).length
    : 0;

  const indexPath = path.join(vaultPath, "index.md");
  const indexedPagePaths = new Set();
  const ambiguousIndexLinks = [];
  if (fs.existsSync(indexPath)) {
    for (const entry of extractWikiLinks(readText(indexPath))) {
      const resolution = resolveLinkTarget(entry.slug, pageBySlug, pagesByBasename);
      if (resolution.kind === "resolved") {
        indexedPagePaths.add(resolution.page.relPath);
        continue;
      }
      if (resolution.kind === "ambiguous") {
        ambiguousIndexLinks.push({
          target: entry.raw,
          candidates: resolution.candidates,
        });
      }
    }
  }
  const missingFromIndex = pages
    .filter((page) => !indexedPagePaths.has(page.relPath))
    .map((page) => page.relPath);

  const suggestedQuestions = [];
  for (const bridgePage of bridgePages) {
    if (bridgePage.connectedSections.length < 2) continue;
    suggestedQuestions.push({
      type: "bridge_page",
      question: `Why does [[${bridgePage.title}]] connect ${bridgePage.connectedSections.join(", ")}?`,
      why: `High betweenness (${bridgePage.betweenness}) - this page bridges distant parts of the vault.`,
    });
  }
  for (const entry of ambiguousLinks.slice(0, 3)) {
    suggestedQuestions.push({
      type: "ambiguous_link",
      question: `Which page should [[${entry.target}]] in ${entry.source} resolve to?`,
      why: `Ambiguous wikilink with multiple candidates: ${entry.candidates.join(", ")}.`,
    });
  }
  for (const entry of orphans.slice(0, 2)) {
    const page = pageBySlug.get(entry.replace(/\.md$/i, "").toLowerCase()) || pages.find((candidate) => candidate.relPath === entry);
    suggestedQuestions.push({
      type: "orphan_page",
      question: `How should [[${page ? getPageTitle(page) : path.basename(entry, ".md")}]] connect back into the vault?`,
      why: "This page has no inbound links and may be missing backlinks, map entries, or merge candidates.",
    });
  }
  for (const entry of missingFromIndex.slice(0, 2)) {
    const page = pages.find((candidate) => candidate.relPath === entry);
    suggestedQuestions.push({
      type: "index_gap",
      question: `Should [[${page ? getPageTitle(page) : path.basename(entry, ".md")}]] be added to index.md or merged elsewhere?`,
      why: "The page exists in the vault but is not reachable from index.md.",
    });
  }

  const dedupedSuggestedQuestions = [];
  const seenQuestions = new Set();
  for (const question of suggestedQuestions) {
    if (seenQuestions.has(question.question)) continue;
    seenQuestions.add(question.question);
    dedupedSuggestedQuestions.push(question);
    if (dedupedSuggestedQuestions.length >= 7) break;
  }

  const topConnected = pages
    .map((page) => ({
      page: page.relPath,
      slug: page.basenameSlug,
      inboundLinks: inbound.get(page.relPath) || 0,
    }))
    .sort((a, b) => b.inboundLinks - a.inboundLinks || a.slug.localeCompare(b.slug))
    .slice(0, 5);

  const stats = {
    vaultPath,
    wikiPages: pages.length,
    rawSources,
    totalCrossReferences: totalLinks,
    uniqueLinkTargets: uniqueTargets.size,
    orphanCount: orphans.length,
    brokenLinkCount: brokenLinks.length,
    ambiguousLinkCount: ambiguousLinks.length,
    weakOutboundCount: weakOutbound.length,
    bridgePageCount: bridgePages.length,
    surprisingConnectionCount: surprisingConnections.length,
    suggestedQuestionCount: dedupedSuggestedQuestions.length,
    missingFromIndexCount: missingFromIndex.length,
    ambiguousIndexLinkCount: ambiguousIndexLinks.length,
    frontmatterIssueCount: frontmatterIssues.length,
  };

  return {
    generatedAt: new Date().toISOString(),
    stats,
    topConnected,
    bridgePages,
    surprisingConnections,
    suggestedQuestions: dedupedSuggestedQuestions,
    orphans,
    brokenLinks,
    ambiguousLinks,
    weakOutbound,
    missingFromIndex,
    ambiguousIndexLinks,
    frontmatterIssues,
  };
}

function formatMarkdown(report) {
  const lines = [];
  const {
    stats,
    topConnected,
    bridgePages,
    surprisingConnections,
    suggestedQuestions,
    orphans,
    brokenLinks,
    ambiguousLinks,
    weakOutbound,
    missingFromIndex,
    ambiguousIndexLinks,
    frontmatterIssues,
  } =
    report;
  lines.push(
    `**${stats.wikiPages} wiki pages, ${stats.rawSources} raw sources, ${stats.totalCrossReferences} cross-references, ${stats.uniqueLinkTargets} unique link targets**`,
  );
  lines.push("");
  if (topConnected.length > 0) {
    const [first, ...rest] = topConnected;
    const restText = rest
      .filter((entry) => entry.inboundLinks > 0)
      .map((entry) => `[[${entry.slug}]] (${entry.inboundLinks})`)
      .join(", ");
    lines.push(
      `The graph is ${stats.totalCrossReferences > 0 ? "connected" : "empty"} — [[${first.slug}]] is the most connected node (${first.inboundLinks} inbound links)${
        restText ? `, followed by ${restText}` : ""
      }.`,
    );
    lines.push("");
  }

  if (
    stats.orphanCount === 0 &&
    stats.brokenLinkCount === 0 &&
    stats.weakOutboundCount === 0 &&
    stats.frontmatterIssueCount === 0 &&
    stats.missingFromIndexCount === 0
  ) {
    lines.push(
      "Every page links to at least 2 others, every link target resolves to a page, and there are zero orphans, zero broken links, and no index/frontmatter gaps.",
    );
    lines.push("");
  } else {
    lines.push("Health summary:");
    lines.push(`- Orphans: ${stats.orphanCount}`);
    lines.push(`- Broken links: ${stats.brokenLinkCount}`);
    lines.push(`- Ambiguous links: ${stats.ambiguousLinkCount}`);
    lines.push(`- Pages with fewer than 2 outbound links: ${stats.weakOutboundCount}`);
    lines.push(`- Bridge pages: ${stats.bridgePageCount}`);
    lines.push(`- Surprising cross-section links: ${stats.surprisingConnectionCount}`);
    lines.push(`- Suggested follow-up questions: ${stats.suggestedQuestionCount}`);
    lines.push(`- Pages missing from index.md: ${stats.missingFromIndexCount}`);
    lines.push(`- Ambiguous index links: ${stats.ambiguousIndexLinkCount}`);
    lines.push(`- Pages with frontmatter issues: ${stats.frontmatterIssueCount}`);
    lines.push("");
  }

  if (orphans.length > 0) {
    lines.push("## Orphans");
    for (const entry of orphans.slice(0, 20)) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }

  if (brokenLinks.length > 0) {
    lines.push("## Broken Links");
    for (const entry of brokenLinks.slice(0, 20)) {
      lines.push(`- ${entry.source} -> [[${entry.target}]]`);
    }
    lines.push("");
  }

  if (ambiguousLinks.length > 0) {
    lines.push("## Ambiguous Links");
    for (const entry of ambiguousLinks.slice(0, 20)) {
      lines.push(`- ${entry.source} -> [[${entry.target}]] (candidates: ${entry.candidates.join(", ")})`);
    }
    lines.push("");
  }

  if (weakOutbound.length > 0) {
    lines.push("## Weak Outbound Linking");
    for (const entry of weakOutbound.slice(0, 20)) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }

  if (bridgePages.length > 0) {
    lines.push("## Bridge Pages");
    for (const entry of bridgePages.slice(0, 10)) {
      lines.push(
        `- ${entry.page} (${entry.betweenness.toFixed(3)} betweenness, ${entry.degree} linked neighbors, sections: ${entry.connectedSections.join(", ") || "none"})`,
      );
    }
    lines.push("");
  }

  if (surprisingConnections.length > 0) {
    lines.push("## Surprising Connections");
    for (const entry of surprisingConnections.slice(0, 10)) {
      lines.push(
        `- [[${entry.sourceTitle}]] (${entry.sourceSection}) -> [[${entry.targetTitle}]] (${entry.targetSection})${entry.note ? ` — ${entry.note}` : ""}`,
      );
    }
    lines.push("");
  }

  if (missingFromIndex.length > 0) {
    lines.push("## Missing From Index");
    for (const entry of missingFromIndex.slice(0, 20)) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }

  if (ambiguousIndexLinks.length > 0) {
    lines.push("## Ambiguous Index Links");
    for (const entry of ambiguousIndexLinks.slice(0, 20)) {
      lines.push(`- [[${entry.target}]] (candidates: ${entry.candidates.join(", ")})`);
    }
    lines.push("");
  }

  if (frontmatterIssues.length > 0) {
    lines.push("## Frontmatter Issues");
    for (const entry of frontmatterIssues.slice(0, 20)) {
      lines.push(`- ${entry.page}: missing ${entry.missing.join(", ")}`);
    }
    lines.push("");
  }

  if (suggestedQuestions.length > 0) {
    lines.push("## Suggested Questions");
    for (const entry of suggestedQuestions.slice(0, 10)) {
      lines.push(`- ${entry.question}`);
      lines.push(`  - ${entry.why}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const vaultPath = path.resolve(args.vault);
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    throw new Error(`Vault path does not exist or is not a directory: ${vaultPath}`);
  }
  const report = buildReport(vaultPath);
  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatMarkdown(report));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
