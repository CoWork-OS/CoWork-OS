#!/usr/bin/env node
// Dependency audit for synchronous SQLite access (async SQLite migration plan, DB6; a
// zero-exception gate since DB7: every file needs a specific, owned rule).
// Every file with tracked synchronous SQLite counts, plus every file in the ratchet register,
// must be explained by a rule in scripts/qa/sqlite-audit-rules.json.
//
//   node scripts/qa/sqlite-audit.mjs            # check; prints the audit by domain
//   node scripts/qa/sqlite-audit.mjs --markdown # the same as a Markdown table
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildInventory } from "./sqlite-inventory.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RULES_PATH = resolve(REPO_ROOT, "scripts/qa/sqlite-audit-rules.json");
const BASELINE_PATH = resolve(REPO_ROOT, "scripts/qa/sqlite-ratchet-baseline.json");
const TRACKED_KEYS = ["prepare", "getDatabase", "runtimeImport"];
const WORKER_MODULE_PATTERNS = [
  /^src\/electron\/database\/async\/database-worker\.ts$/,
  /^src\/electron\/database\/async\/commands\.ts$/,
  /^src\/electron\/database\/fts-worker\.ts$/,
  /^src\/electron\/memory\/memory-embedding-cache\.ts$/,
];
const isWorkerModule = (path) => WORKER_MODULE_PATTERNS.some((pattern) => pattern.test(path));

export function audit(options = {}) {
  const baseline = options.baseline ?? JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const rules = options.rules ?? JSON.parse(readFileSync(RULES_PATH, "utf8")).rules;
  const includeCurrentInventory =
    options.inventory !== undefined || !Object.hasOwn(options, "baseline");
  const files = new Map(Object.entries(baseline.files));
  if (includeCurrentInventory) {
    const inventory = options.inventory ?? buildInventory({ cwd: REPO_ROOT });
    for (const file of inventory.files) {
      if (isWorkerModule(file.path)) continue;
      const counts = Object.fromEntries(
        TRACKED_KEYS.filter((key) => file.counts[key] > 0).map((key) => [key, file.counts[key]]),
      );
      if (Object.keys(counts).length > 0) files.set(file.path, counts);
    }
  }
  const compiled = rules.map((rule) => ({ ...rule, regex: new RegExp(rule.pattern) }));
  const domains = new Map();
  const unexplained = [];
  // DB7 gate: a file only a backstop rule matches, and a rule without an owner, both fail.
  const backstopped = [];
  const unowned = compiled.filter((rule) => !rule.owner).map((rule) => rule.pattern);
  for (const [file, counts] of files) {
    const rule = compiled.find((candidate) => candidate.regex.test(file));
    if (!rule) {
      unexplained.push(file);
      continue;
    }
    if (rule.backstop) backstopped.push(file);
    const entry = domains.get(rule.domain) ?? {
      domain: rule.domain,
      files: 0,
      prepare: 0,
      getDatabase: 0,
      runtimeImport: 0,
      rules: new Map(),
    };
    entry.files += 1;
    for (const key of ["prepare", "getDatabase", "runtimeImport"]) entry[key] += counts[key] ?? 0;
    entry.rules.set(rule.pattern, rule);
    domains.set(rule.domain, entry);
  }
  return {
    unexplained,
    backstopped,
    unowned,
    domains: [...domains.values()]
      .sort((a, b) => b.prepare - a.prepare)
      .map(({ rules: ruleMap, ...rest }) => ({ ...rest, rules: [...ruleMap.values()] })),
  };
}

export function main(argv = process.argv.slice(2)) {
  const result = audit();
  const rows = result.domains.map((domain) => [
    domain.domain,
    String(domain.files),
    String(domain.prepare),
    String(domain.getDatabase),
    domain.rules
      .map((rule) => rule.plan)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join("; "),
  ]);
  if (argv.includes("--markdown")) {
    process.stdout.write(
      [
        "| Domain | Files | `prepare` | `getDatabase` | Plan |",
        "| --- | --- | --- | --- | --- |",
        ...rows.map((row) => `| ${row.join(" | ")} |`),
      ].join("\n") + "\n",
    );
  } else {
    for (const row of rows) process.stdout.write(`${row.join("  ")}\n`);
  }
  if (result.backstopped.length > 0) {
    process.stderr.write(
      `Synchronous SQLite access only a backstop rule covers (move it into units, or add a reviewed rule with an owner):\n${result.backstopped
        .map((file) => `  ${file}`)
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
  if (result.unowned.length > 0) {
    process.stderr.write(
      `Audit rules without an owner:\n${result.unowned.map((p) => `  ${p}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  }
  if (result.unexplained.length > 0) {
    process.stderr.write(
      `Synchronous SQLite access with no explanation in ${RULES_PATH}:\n${result.unexplained
        .map((file) => `  ${file}`)
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
