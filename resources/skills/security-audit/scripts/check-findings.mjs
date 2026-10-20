#!/usr/bin/env node
// Checks a security-audit findings.json, and optionally cross-checks it against the ledger.
// Usage: node check-findings.mjs <findings.json> [--ledger <coverage-ledger.json>]
import { readJsonFile, report, validateFindings, validateLedger } from "./audit-format.mjs";

const args = process.argv.slice(2);
let ledgerPath = null;
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--ledger") {
    ledgerPath = args[i + 1];
    i += 1;
  } else {
    files.push(args[i]);
  }
}

if (files.length !== 1 || (ledgerPath !== null && !ledgerPath)) {
  process.stderr.write(
    "Usage: node check-findings.mjs <findings.json> [--ledger <coverage-ledger.json>]\n",
  );
  process.exit(2);
}

const findings = readJsonFile(files[0]);
if (findings.error) process.exit(report("findings", [findings.error], ""));

let ledgerUnits = null;
if (ledgerPath) {
  const ledger = readJsonFile(ledgerPath);
  if (ledger.error) process.exit(report("findings", [ledger.error], ""));
  const ledgerResult = validateLedger(ledger.data);
  if (ledgerResult.errors.length > 0) {
    process.exit(
      report("findings", ["the ledger has errors; run check-ledger.mjs on it first"], ""),
    );
  }
  ledgerUnits = ledgerResult.units;
}

const { errors, summary } = validateFindings(findings.data, { ledgerUnits });
const okLine = summary
  ? `${summary.total} findings: ${summary.byVerdict.confirmed} confirmed (` +
    Object.entries(summary.bySeverity)
      .map(([severity, count]) => `${severity} ${count}`)
      .join(", ") +
    `), ${summary.byVerdict.needs_validation} needs_validation, ${summary.byVerdict.rejected} rejected.`
  : "";
process.exit(report("findings", errors, okLine));
