#!/usr/bin/env node
// Ratchet for synchronous SQLite access on application threads (async SQLite
// migration plan, decision 10). Per file, the counts of `.prepare(` calls,
// `getDatabase()` calls, and runtime `better-sqlite3` imports may only go down.
// The baseline file is the exception register: every remaining site is listed there.
//
//   node scripts/qa/sqlite-ratchet.mjs            # check (also run by tests/sqlite-ratchet.test.ts)
//   node scripts/qa/sqlite-ratchet.mjs --update   # rewrite the baseline after removing sites
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildInventory } from "./sqlite-inventory.mjs";
import { RULES_PATH } from "./sqlite-audit.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE_PATH = resolve(REPO_ROOT, "scripts/qa/sqlite-ratchet-baseline.json");
export const TRACKED_KEYS = ["prepare", "getDatabase", "runtimeImport"];

/** Modules that are allowed to use SQLite directly because they run off the application thread. */
export const WORKER_MODULE_PATTERNS = [
  /^src\/electron\/database\/async\/database-worker\.ts$/,
  /^src\/electron\/database\/async\/commands\.ts$/,
  /^src\/electron\/database\/fts-worker\.ts$/,
  // Imported only by fts-worker.ts: the worker's own embedding cache (DB4).
  /^src\/electron\/memory\/memory-embedding-cache\.ts$/,
];

const isWorkerModule = (path) => WORKER_MODULE_PATTERNS.some((pattern) => pattern.test(path));

/** Tracked, non-zero counts per application-thread file. */
export function trackedCounts(inventory) {
  const files = {};
  for (const file of inventory.files) {
    if (isWorkerModule(file.path)) continue;
    const counts = {};
    for (const key of TRACKED_KEYS) if (file.counts[key] > 0) counts[key] = file.counts[key];
    if (Object.keys(counts).length > 0) files[file.path] = counts;
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Files whose SQL runs in transaction units (the audit's "shared SQL" rules, DB7): their
 * statements execute in the database worker, so their counts may grow without an update.
 */
export function unitStoreMatcher(rules = JSON.parse(readFileSync(RULES_PATH, "utf8")).rules) {
  const compiled = rules.map((rule) => ({ ...rule, regex: new RegExp(rule.pattern) }));
  return (path) => compiled.find((rule) => rule.regex.test(path))?.domain === "shared SQL";
}

export function compareToBaseline(current, baseline, isUnitStore = () => false) {
  const increased = [];
  const decreased = [];
  const paths = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const path of [...paths].sort()) {
    for (const key of TRACKED_KEYS) {
      const now = current[path]?.[key] ?? 0;
      const before = baseline[path]?.[key] ?? 0;
      if (now > before && !isUnitStore(path)) increased.push({ path, key, before, now });
      else if (now < before) decreased.push({ path, key, before, now });
    }
  }
  return { increased, decreased };
}

export function buildBaseline(current) {
  const totals = Object.fromEntries(TRACKED_KEYS.map((key) => [key, 0]));
  for (const counts of Object.values(current)) {
    for (const key of TRACKED_KEYS) totals[key] += counts[key] ?? 0;
  }
  return {
    description:
      "Exception register for synchronous SQLite access on application threads. Counts may only decrease; see docs/async-sqlite-migration-plan-2026-09-27.md (decision 10).",
    tracked: TRACKED_KEYS,
    totals,
    files: current,
  };
}

export function readBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function checkRatchet({ cwd = REPO_ROOT, baselinePath = BASELINE_PATH } = {}) {
  const current = trackedCounts(buildInventory({ cwd }));
  return {
    current,
    ...compareToBaseline(current, readBaseline(baselinePath).files, unitStoreMatcher()),
  };
}

export function formatReport({ increased, decreased }) {
  const lines = [];
  if (increased.length > 0) {
    lines.push("New synchronous SQLite access on an application thread:");
    for (const entry of increased) {
      lines.push(`  ${entry.path}: ${entry.key} ${entry.before} -> ${entry.now}`);
    }
    lines.push(
      "Route new database work through an existing repository call, or move it off the host thread.",
    );
  }
  if (decreased.length > 0) {
    lines.push(
      "Synchronous SQLite access went down; lock it in with `npm run qa:db:ratchet -- --update`:",
    );
    for (const entry of decreased) {
      lines.push(`  ${entry.path}: ${entry.key} ${entry.before} -> ${entry.now}`);
    }
  }
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--update")) {
    const current = trackedCounts(buildInventory({ cwd: REPO_ROOT }));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(buildBaseline(current), null, 2)}\n`);
    process.stdout.write(`Updated ${BASELINE_PATH}\n`);
    return;
  }
  const result = checkRatchet();
  if (result.increased.length === 0 && result.decreased.length === 0) {
    process.stdout.write("SQLite ratchet passed.\n");
    return;
  }
  process.stderr.write(`${formatReport(result)}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
