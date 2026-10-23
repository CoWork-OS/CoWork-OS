#!/usr/bin/env node
// Checks a security-audit coverage-ledger.json.
// Usage: node check-ledger.mjs [--final] <coverage-ledger.json>
import { readJsonFile, report, validateLedger } from "./audit-format.mjs";

const args = process.argv.slice(2);
const final = args.includes("--final");
const files = args.filter((arg) => arg !== "--final");

if (files.length !== 1) {
  process.stderr.write("Usage: node check-ledger.mjs [--final] <coverage-ledger.json>\n");
  process.exit(2);
}

const { data, error } = readJsonFile(files[0]);
if (error) process.exit(report("coverage-ledger", [error], ""));

const { errors, units, counts } = validateLedger(data, { final });
const breakdown = Object.entries(counts || {})
  .map(([status, count]) => `${status} ${count}`)
  .join(", ");
process.exit(report("coverage-ledger", errors, `${units.length} units (${breakdown || "none"}).`));
