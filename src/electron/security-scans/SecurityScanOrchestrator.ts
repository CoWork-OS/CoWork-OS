import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

export type SecurityScanMode = "repository" | "scoped_path" | "diff" | "deep_repository";

export interface SecurityScanPrepareInput {
  repoRoot: string;
  mode: SecurityScanMode;
  workspaceRoot?: string;
  scope?: string;
  base?: string;
  head?: string;
  diffMode?: "revisions" | "local-patch";
  artifactRoot?: string;
  scanId?: string;
  deepRounds?: number;
}

export interface SecurityScanPaths {
  pluginDir: string;
  repoRoot: string;
  repoName: string;
  securityScansDir: string;
  scanId: string;
  scanDir: string;
  artifactsDir: string;
  contextDir: string;
  discoveryDir: string;
  coverageDir: string;
  reconciliationDir: string;
  findingsDir: string;
  rankInput: string;
  deepReviewInput: string;
  reportMd: string;
  reportHtml: string;
}

export interface SecurityScanPrepareResult {
  mode: SecurityScanMode;
  paths: SecurityScanPaths;
  rankInputRows: number;
  deepReviewRows: number;
  terminalState: "prepared";
  deepScan?: {
    workersPerRound: 6;
    maxRounds: number;
    workerArtifactRoot: string;
    requiredWorkerFiles: string[];
    canonicalWorkerBrief: string;
  };
}

export interface WorkerArtifactStatus {
  usable: boolean;
  workerDir: string;
  missing: string[];
  present: string[];
  parseErrors: string[];
  candidateRows: number;
}

export interface RoundMergeResult {
  scanDir: string;
  round: string;
  workerCount: number;
  usableWorkerCount: number;
  candidateCount: number;
  newExactKeyCount: number;
  inventoryJsonl: string;
  inventoryMarkdown: string;
  canonicalInventoryJsonl: string;
  terminalState: "continue" | "saturated_exact";
}

export interface ReportValidationResult {
  valid: boolean;
  reportMd: string;
  reportHtml: string;
  validationOutput: string;
  renderOutput?: string;
}

const REQUIRED_WORKER_FILES = [
  "threat_model.md",
  "finding_discovery_report.md",
  "seed_research.md",
  "work_ledger.jsonl",
  "raw_candidates.jsonl",
  "dedupe_report.md",
  "deduped_candidates.jsonl",
  "repository_coverage_ledger.md",
];

const REQUIRED_WORKER_JSONL_FILES = [
  "work_ledger.jsonl",
  "raw_candidates.jsonl",
  "deduped_candidates.jsonl",
];

const SECURITY_SCAN_MODES = new Set<SecurityScanMode>([
  "repository",
  "scoped_path",
  "diff",
  "deep_repository",
]);

function getPackagedPluginDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = Boolean(resourcesPath && fs.existsSync(path.join(resourcesPath, "plugin-packs")));
  return packaged
    ? path.join(resourcesPath || "", "plugin-packs", "codex-security")
    : path.join(process.cwd(), "resources", "plugin-packs", "codex-security");
}

function runCommand(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return output;
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function countCsvDataRows(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const text = fs.readFileSync(filePath, "utf-8").trim();
  if (!text) return 0;
  return Math.max(0, text.split(/\r?\n/).length - 1);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function isPathWithin(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep);
}

function readJsonlWithErrors(filePath: string): { rows: unknown[]; errors: string[] } {
  if (!fs.existsSync(filePath)) return { rows: [], errors: [] };
  const rows: unknown[] = [];
  const errors: string[] = [];
  const text = fs.readFileSync(filePath, "utf-8");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (error) {
      errors.push(`${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { rows, errors };
}

function readJsonlStrict(filePath: string): unknown[] {
  const result = readJsonlWithErrors(filePath);
  if (result.errors.length > 0) {
    throw new Error(`Malformed JSONL in ${filePath}:\n${result.errors.join("\n")}`);
  }
  return result.rows;
}

function stableCandidateKey(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object") {
    return JSON.stringify(candidate);
  }
  const record = candidate as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim().toLowerCase() : "";
  const locations = Array.isArray(record.affected_locations)
    ? record.affected_locations
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const item = entry as Record<string, unknown>;
          return `${item.path || ""}:${item.lines || ""}:${item.label || ""}`;
        })
        .sort()
        .join("|")
    : "";
  const sink = typeof record.vulnerable_sink === "string" ? record.vulnerable_sink : "";
  const control = typeof record.broken_control === "string" ? record.broken_control : "";
  return [title, locations, sink, control].join("::");
}

function buildPaths(input: SecurityScanPrepareInput, pluginDir: string): SecurityScanPaths {
  const repoRoot = path.resolve(input.repoRoot);
  const repoName = path.basename(repoRoot);
  const commit = (() => {
    try {
      return runCommand("git", ["rev-parse", "--short=12", "HEAD"], repoRoot).trim();
    } catch {
      return "no-git";
    }
  })();
  const scanId = input.scanId || `${commit}_${safeTimestamp()}`;
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(scanId) || scanId.includes("..")) {
    throw new Error("Security scan id must contain only letters, numbers, dot, underscore, or dash");
  }
  const securityScansDir = path.resolve(input.artifactRoot || path.join(repoRoot, ".cowork", "security-scans", repoName));
  const scanDir = path.join(securityScansDir, scanId);
  if (!isPathWithin(securityScansDir, scanDir)) {
    throw new Error(`Security scan directory must stay under artifact root: ${scanDir}`);
  }
  const artifactsDir = path.join(scanDir, "artifacts");
  const contextDir = path.join(artifactsDir, "01_context");
  const discoveryDir = path.join(artifactsDir, "02_discovery");
  const coverageDir = path.join(artifactsDir, "03_coverage");
  const reconciliationDir = path.join(artifactsDir, "04_reconciliation");
  const findingsDir = path.join(artifactsDir, "05_findings");
  return {
    pluginDir,
    repoRoot,
    repoName,
    securityScansDir,
    scanId,
    scanDir,
    artifactsDir,
    contextDir,
    discoveryDir,
    coverageDir,
    reconciliationDir,
    findingsDir,
    rankInput: path.join(discoveryDir, "rank_input.csv"),
    deepReviewInput: path.join(discoveryDir, "deep_review_input.csv"),
    reportMd: path.join(scanDir, "report.md"),
    reportHtml: path.join(scanDir, "report.html"),
  };
}

function canonicalBrief(paths: SecurityScanPaths): string {
  return [
    "Run the Codex Security threat-model phase and then the finding-discovery phase only.",
    "",
    `Resolved scan target: ${paths.repoRoot}`,
    `Shared rank input: ${paths.rankInput}`,
    `Shared exhaustive deep review input: ${paths.deepReviewInput}`,
    "",
    "Generate your own repository-level threat model at your worker-specific threat_model.md path. Then run finding discovery using the shared worklists exactly as supplied. Do not run validation, attack-path analysis, final report assembly, or edit repository files. Write all outputs only under your assigned worker directory.",
  ].join("\n");
}

export class SecurityScanOrchestrator {
  prepareScan(input: SecurityScanPrepareInput): SecurityScanPrepareResult {
    const pluginDir = getPackagedPluginDir();
    if (!SECURITY_SCAN_MODES.has(input.mode)) {
      throw new Error(`Unsupported security scan mode: ${String(input.mode)}`);
    }
    if (input.mode === "deep_repository" && input.scope) {
      throw new Error("Deep Security Scan is repository-wide only; use mode=scoped_path for scoped scans");
    }
    const paths = buildPaths(input, pluginDir);
    const workspaceRoot = input.workspaceRoot ? path.resolve(input.workspaceRoot) : undefined;
    if (workspaceRoot) {
      if (!isPathWithin(workspaceRoot, paths.repoRoot)) {
        throw new Error(`Security scan repository root must be inside the workspace: ${paths.repoRoot}`);
      }
      if (!isPathWithin(workspaceRoot, paths.securityScansDir)) {
        throw new Error(`Security scan artifact root must be inside the workspace: ${paths.securityScansDir}`);
      }
    }
    if (!fs.existsSync(paths.repoRoot) || !fs.statSync(paths.repoRoot).isDirectory()) {
      throw new Error(`Repository root does not exist: ${paths.repoRoot}`);
    }

    for (const dir of [
      paths.scanDir,
      paths.artifactsDir,
      paths.contextDir,
      paths.discoveryDir,
      paths.coverageDir,
      paths.reconciliationDir,
      paths.findingsDir,
    ]) {
      ensureDir(dir);
    }

    const generator = path.join(pluginDir, "scripts", "generate_rank_input.py");
    if (!fs.existsSync(generator)) {
      throw new Error(`Missing Codex Security worklist helper: ${generator}`);
    }

    if (input.mode === "diff") {
      if (!input.base) {
        throw new Error("Diff security scans require a base revision");
      }
      const args = [
        generator,
        "make-diff-rank-input",
        "--repo",
        paths.repoRoot,
        "--base",
        input.base,
        "--mode",
        input.diffMode || "revisions",
        "--out",
        paths.rankInput,
      ];
      if (input.head) args.push("--head", input.head);
      runCommand("python3", args, paths.repoRoot);
    } else {
      const args = [
        generator,
        "make-repo-rank-input",
        "--repo",
        paths.repoRoot,
        "--out",
        paths.rankInput,
      ];
      if (input.mode === "scoped_path") {
        if (!input.scope) {
          throw new Error("Scoped-path security scans require scope");
        }
        if (path.isAbsolute(input.scope) || input.scope.split(/[\\/]+/).includes("..")) {
          throw new Error("Scoped-path security scan scope must be a relative path inside the repository");
        }
        args.push("--scope", input.scope);
      }
      runCommand("python3", args, paths.repoRoot);
    }

    runCommand(
      "python3",
      [
        generator,
        "copy-deep-review-input",
        "--rank-input",
        paths.rankInput,
        "--out",
        paths.deepReviewInput,
      ],
      paths.repoRoot,
    );

    const deepRounds = Math.min(Math.max(input.deepRounds || 10, 1), 10);
    const result: SecurityScanPrepareResult = {
      mode: input.mode,
      paths,
      rankInputRows: countCsvDataRows(paths.rankInput),
      deepReviewRows: countCsvDataRows(paths.deepReviewInput),
      terminalState: "prepared",
    };
    if (input.mode === "deep_repository") {
      const workerArtifactRoot = path.join(paths.artifactsDir, "deep_discovery");
      ensureDir(workerArtifactRoot);
      result.deepScan = {
        workersPerRound: 6,
        maxRounds: deepRounds,
        workerArtifactRoot,
        requiredWorkerFiles: [...REQUIRED_WORKER_FILES],
        canonicalWorkerBrief: canonicalBrief(paths),
      };
    }
    return result;
  }

  createDeepWorkerDirs(scanDir: string, round: number, workerCount = 6): string[] {
    if (workerCount !== 6) {
      throw new Error("Deep Security Scan requires exactly 6 workers per completed round");
    }
    if (!Number.isInteger(round) || round < 1 || round > 10) {
      throw new Error("Deep Security Scan round must be an integer from 1 to 10");
    }
    const artifactsDir = path.join(path.resolve(scanDir), "artifacts");
    const roundDir = path.join(artifactsDir, "deep_discovery", `round-${String(round).padStart(2, "0")}`);
    const dirs: string[] = [];
    for (let i = 1; i <= workerCount; i++) {
      const workerDir = path.join(roundDir, `worker-${String(i).padStart(2, "0")}`);
      ensureDir(path.join(workerDir, "findings"));
      dirs.push(workerDir);
    }
    return dirs;
  }

  checkWorkerArtifacts(workerDir: string): WorkerArtifactStatus {
    const resolved = path.resolve(workerDir);
    const present: string[] = [];
    const missing: string[] = [];
    const parseErrors: string[] = [];
    for (const file of REQUIRED_WORKER_FILES) {
      const fullPath = path.join(resolved, file);
      if (fs.existsSync(fullPath)) {
        present.push(file);
      } else {
        missing.push(file);
      }
    }
    for (const file of REQUIRED_WORKER_JSONL_FILES) {
      if (!fs.existsSync(path.join(resolved, file))) continue;
      parseErrors.push(...readJsonlWithErrors(path.join(resolved, file)).errors);
    }
    const candidateRows = readJsonlWithErrors(path.join(resolved, "deduped_candidates.jsonl")).rows.length;
    return {
      usable: missing.length === 0 && parseErrors.length === 0,
      workerDir: resolved,
      missing,
      present,
      parseErrors,
      candidateRows,
    };
  }

  mergeDeepRound(scanDir: string, round: number): RoundMergeResult {
    if (!Number.isInteger(round) || round < 1 || round > 10) {
      throw new Error("Deep Security Scan round must be an integer from 1 to 10");
    }
    const resolvedScanDir = path.resolve(scanDir);
    const artifactsDir = path.join(resolvedScanDir, "artifacts");
    const roundName = `round-${String(round).padStart(2, "0")}`;
    const roundDir = path.join(artifactsDir, "deep_discovery", roundName);
    const mergeDir = path.join(artifactsDir, "deep_merge");
    ensureDir(mergeDir);
    const canonicalInventoryJsonl = path.join(mergeDir, "canonical_candidate_inventory.jsonl");
    const previousKeys = new Set(readJsonlStrict(canonicalInventoryJsonl).map(stableCandidateKey));

    const workerDirs = fs.existsSync(roundDir)
      ? fs.readdirSync(roundDir)
          .filter((entry) => entry.startsWith("worker-"))
          .map((entry) => path.join(roundDir, entry))
          .filter((entry) => fs.statSync(entry).isDirectory())
          .sort()
      : [];

    const merged: Array<Record<string, unknown>> = [];
    let usableWorkerCount = 0;
    for (const workerDir of workerDirs) {
      const status = this.checkWorkerArtifacts(workerDir);
      if (!status.usable) continue;
      usableWorkerCount++;
      const workerId = path.basename(workerDir);
      for (const candidate of readJsonlStrict(path.join(workerDir, "deduped_candidates.jsonl"))) {
        merged.push({
          ...(candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : { value: candidate }),
          _deep_scan_provenance: {
            round: roundName,
            worker: workerId,
            source: path.join(workerDir, "deduped_candidates.jsonl"),
          },
        });
      }
    }
    if (workerDirs.length !== 6 || usableWorkerCount !== 6) {
      throw new Error(
        `Deep Security Scan round ${roundName} is incomplete: workers=${workerDirs.length}, usable=${usableWorkerCount}; exactly 6 usable workers are required before merge`,
      );
    }

    const seen = new Set<string>();
    const canonical = [...readJsonlStrict(canonicalInventoryJsonl) as Record<string, unknown>[]];
    let newExactKeyCount = 0;
    for (const candidate of merged) {
      const key = stableCandidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!previousKeys.has(key)) {
        newExactKeyCount++;
        canonical.push(candidate);
      }
    }

    const inventoryJsonl = path.join(mergeDir, `${roundName}_candidate_inventory.jsonl`);
    const inventoryMarkdown = path.join(mergeDir, `${roundName}_candidate_inventory.md`);
    fs.writeFileSync(inventoryJsonl, merged.map((row) => JSON.stringify(row)).join("\n") + (merged.length ? "\n" : ""));
    fs.writeFileSync(
      canonicalInventoryJsonl,
      canonical.map((row) => JSON.stringify(row)).join("\n") + (canonical.length ? "\n" : ""),
    );
    fs.writeFileSync(
      inventoryMarkdown,
      [
        `# ${roundName} Candidate Inventory`,
        "",
        `Workers found: ${workerDirs.length}`,
        `Usable workers: ${usableWorkerCount}`,
        `Candidate rows: ${merged.length}`,
        `New exact keys: ${newExactKeyCount}`,
        "",
        "Exact-key novelty is a deterministic bookkeeping aid. The Codex Security skill must still perform semantic remediation-subsumption merge before validation.",
      ].join("\n"),
    );

    return {
      scanDir: resolvedScanDir,
      round: roundName,
      workerCount: workerDirs.length,
      usableWorkerCount,
      candidateCount: merged.length,
      newExactKeyCount,
      inventoryJsonl,
      inventoryMarkdown,
      canonicalInventoryJsonl,
      terminalState: newExactKeyCount === 0 ? "saturated_exact" : "continue",
    };
  }

  validateAndRenderReport(scanDir: string, title?: string): ReportValidationResult {
    const resolvedScanDir = path.resolve(scanDir);
    const reportMd = path.join(resolvedScanDir, "report.md");
    const reportHtml = path.join(resolvedScanDir, "report.html");
    const pluginDir = getPackagedPluginDir();
    const validator = path.join(pluginDir, "scripts", "validate_report_format.py");
    const renderer = path.join(pluginDir, "scripts", "render_report_html.py");
    const template = path.join(pluginDir, "assets", "report_template_inlined.html");
    if (!fs.existsSync(reportMd)) {
      throw new Error(`Missing report.md: ${reportMd}`);
    }
    const validationOutput = runCommand("python3", [validator, "--report-md", reportMd], resolvedScanDir);
    const renderOutput = runCommand(
      "python3",
      [
        renderer,
        "--template",
        template,
        "--report-md",
        reportMd,
        "--report-html",
        reportHtml,
        "--title",
        title || "Codex Security Scan",
      ],
      resolvedScanDir,
    );
    return {
      valid: true,
      reportMd,
      reportHtml,
      validationOutput,
      renderOutput,
    };
  }
}

let instance: SecurityScanOrchestrator | null = null;

export function getSecurityScanOrchestrator(): SecurityScanOrchestrator {
  if (!instance) {
    instance = new SecurityScanOrchestrator();
  }
  return instance;
}
