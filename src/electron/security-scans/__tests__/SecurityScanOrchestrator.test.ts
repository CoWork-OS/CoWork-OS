import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecurityScanOrchestrator } from "../SecurityScanOrchestrator";

let tmpDir: string;

function writeWorkerArtifacts(workerDir: string, title: string): void {
  fs.mkdirSync(workerDir, { recursive: true });
  for (const file of [
    "threat_model.md",
    "finding_discovery_report.md",
    "seed_research.md",
    "dedupe_report.md",
    "repository_coverage_ledger.md",
  ]) {
    fs.writeFileSync(path.join(workerDir, file), `${file}\n`);
  }
  fs.writeFileSync(path.join(workerDir, "work_ledger.jsonl"), "{}\n");
  fs.writeFileSync(path.join(workerDir, "raw_candidates.jsonl"), "{}\n");
  fs.writeFileSync(
    path.join(workerDir, "deduped_candidates.jsonl"),
    `${JSON.stringify({
      candidate_id: title.toLowerCase().replace(/\s+/g, "-"),
      title,
      affected_locations: [{ label: "root_control", path: "src/index.ts", lines: "1" }],
      broken_control: "missing policy gate",
    })}\n`,
  );
}

describe("SecurityScanOrchestrator", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-security-scan-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prepares standard scan artifacts and exhaustive worklists", () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "index.ts"), "export const value = 1;\n");

    const result = new SecurityScanOrchestrator().prepareScan({
      repoRoot,
      workspaceRoot: repoRoot,
      mode: "deep_repository",
      scanId: "test-scan",
    });

    expect(result.paths.scanDir).toBe(path.join(repoRoot, ".cowork", "security-scans", "repo", "test-scan"));
    expect(fs.existsSync(result.paths.rankInput)).toBe(true);
    expect(fs.existsSync(result.paths.deepReviewInput)).toBe(true);
    expect(result.rankInputRows).toBeGreaterThan(0);
    expect(result.deepReviewRows).toBe(result.rankInputRows);
    expect(result.deepScan?.workersPerRound).toBe(6);
  });

  it("checks worker artifacts and writes deterministic round inventories", () => {
    const orchestrator = new SecurityScanOrchestrator();
    const scanDir = path.join(tmpDir, "scan");
    const workerDirs = orchestrator.createDeepWorkerDirs(scanDir, 1);

    for (let index = 0; index < workerDirs.length; index++) {
      writeWorkerArtifacts(
        workerDirs[index],
        index < 3 ? "Policy bypass" : `Webhook missing auth ${index}`,
      );
    }

    const status = orchestrator.checkWorkerArtifacts(workerDirs[0]);
    expect(status.usable).toBe(true);
    expect(status.candidateRows).toBe(1);

    const merge = orchestrator.mergeDeepRound(scanDir, 1);
    expect(merge.usableWorkerCount).toBe(6);
    expect(merge.candidateCount).toBe(6);
    expect(merge.newExactKeyCount).toBe(4);
    expect(fs.existsSync(merge.inventoryJsonl)).toBe(true);
    expect(fs.existsSync(merge.canonicalInventoryJsonl)).toBe(true);
  });

  it("rejects scan roots outside the workspace", () => {
    const workspaceRoot = path.join(tmpDir, "workspace");
    const outsideRoot = path.join(tmpDir, "outside");
    fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(outsideRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(outsideRoot, "src", "index.ts"), "export const value = 1;\n");

    expect(() =>
      new SecurityScanOrchestrator().prepareScan({
        repoRoot: outsideRoot,
        workspaceRoot,
        mode: "repository",
      }),
    ).toThrow(/inside the workspace/);
  });

  it("rejects scan ids that can escape the artifact directory", () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "index.ts"), "export const value = 1;\n");

    expect(() =>
      new SecurityScanOrchestrator().prepareScan({
        repoRoot,
        workspaceRoot: repoRoot,
        mode: "repository",
        scanId: "../escape",
      }),
    ).toThrow(/scan id/);
  });

  it("rejects scoped scans outside the repository", () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "index.ts"), "export const value = 1;\n");

    expect(() =>
      new SecurityScanOrchestrator().prepareScan({
        repoRoot,
        workspaceRoot: repoRoot,
        mode: "scoped_path",
        scope: "../outside",
      }),
    ).toThrow(/relative path inside the repository/);
  });

  it("does not merge incomplete deep rounds", () => {
    const orchestrator = new SecurityScanOrchestrator();
    const scanDir = path.join(tmpDir, "scan");
    const workerDirs = orchestrator.createDeepWorkerDirs(scanDir, 1);
    writeWorkerArtifacts(workerDirs[0], "Policy bypass");

    expect(() => orchestrator.mergeDeepRound(scanDir, 1)).toThrow(/exactly 6 usable workers/);
  });

  it("marks malformed worker JSONL as unusable", () => {
    const orchestrator = new SecurityScanOrchestrator();
    const scanDir = path.join(tmpDir, "scan");
    const workerDirs = orchestrator.createDeepWorkerDirs(scanDir, 1);
    writeWorkerArtifacts(workerDirs[0], "Policy bypass");
    fs.appendFileSync(path.join(workerDirs[0], "deduped_candidates.jsonl"), "{bad-json\n");

    const status = orchestrator.checkWorkerArtifacts(workerDirs[0]);
    expect(status.usable).toBe(false);
    expect(status.parseErrors.length).toBeGreaterThan(0);
  });
});
