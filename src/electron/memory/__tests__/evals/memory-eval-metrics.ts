/**
 * Metrics and the report of the memory evals (audit §8.5). Pure functions; the eval test
 * computes them over a seeded profile and checks them against the fixture thresholds.
 */
import fs from "fs";
import path from "path";

export interface RankedQueryResult {
  id: string;
  lang?: string;
  expect: string[];
  /** Fixture keys of the returned hits, best first (unknown refs as `?<ref>`). */
  returned: string[];
}

/** Share of queries with at least one expected key in the top `k`. */
export function recallAtK(results: RankedQueryResult[], k: number): number {
  if (results.length === 0) return 0;
  const hits = results.filter((result) =>
    result.returned.slice(0, k).some((key) => result.expect.includes(key)),
  ).length;
  return hits / results.length;
}

/** Mean reciprocal rank of the first expected key (0 when it is not returned). */
export function meanReciprocalRank(results: RankedQueryResult[]): number {
  if (results.length === 0) return 0;
  let total = 0;
  for (const result of results) {
    const rank = result.returned.findIndex((key) => result.expect.includes(key));
    if (rank >= 0) total += 1 / (rank + 1);
  }
  return total / results.length;
}

/** Queries whose expected keys are all missing from the top `k`. */
export function missesAtK(results: RankedQueryResult[], k: number): RankedQueryResult[] {
  return results.filter(
    (result) => !result.returned.slice(0, k).some((key) => result.expect.includes(key)),
  );
}

/** recall@k per language tag. */
export function recallAtKByLang(results: RankedQueryResult[], k: number): Record<string, number> {
  const groups = new Map<string, RankedQueryResult[]>();
  for (const result of results) {
    const lang = result.lang ?? "unknown";
    groups.set(lang, [...(groups.get(lang) ?? []), result]);
  }
  return Object.fromEntries(
    [...groups.entries()].map(([lang, group]) => [lang, round(recallAtK(group, k))]),
  );
}

/** (rows − distinct keys) / rows: the share of rows that repeat an earlier row. */
export function duplicateRate(keys: string[]): number {
  if (keys.length === 0) return 0;
  return (keys.length - new Set(keys).size) / keys.length;
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface SuiteReport {
  suite: string;
  passed: boolean;
  metrics: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  failures: string[];
  details?: Record<string, unknown>;
}

const reports: SuiteReport[] = [];

export function recordSuiteReport(report: SuiteReport): void {
  reports.push(report);
}

export function suiteReports(): SuiteReport[] {
  return [...reports];
}

/**
 * Print a one-line summary per suite and, when `COWORK_MEMORY_EVAL_REPORT_DIR` names a
 * directory, write each suite's full JSON report there as `<suite>.json` (CI artifact; the
 * suites run in separate test files, so each writes its own file).
 */
export function flushSuiteReports(): void {
  if (reports.length === 0) return;
  const targetDir = process.env.COWORK_MEMORY_EVAL_REPORT_DIR;
  if (targetDir) fs.mkdirSync(path.resolve(targetDir), { recursive: true });
  for (const report of reports) {
    const metrics = Object.entries(report.metrics)
      .filter(([, value]) => typeof value === "number" || typeof value === "boolean")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    // Written to stderr directly: the test runner hides console output of passing tests.
    process.stderr.write(
      `[memory-evals] ${report.suite}: ${report.passed ? "PASS" : "FAIL"} ${metrics}\n`,
    );
    for (const failure of report.failures) {
      process.stderr.write(`[memory-evals]   - ${failure}\n`);
    }
    if (targetDir) {
      fs.writeFileSync(
        path.join(path.resolve(targetDir), `${report.suite}.json`),
        `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2)}\n`,
      );
    }
  }
  reports.length = 0;
}
