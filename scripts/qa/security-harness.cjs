/* eslint-disable no-console */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_OUTPUT_DIR = path.join("artifacts", "security-harness");
const DEFAULT_REPORT_PATH = path.join(DEFAULT_OUTPUT_DIR, "security-harness-report.json");
const DEFAULT_MISSION_CONTROL_PATH = path.join(DEFAULT_OUTPUT_DIR, "mission-control-findings.json");
const DEFAULT_EVAL_CASE_PATH = path.join(
  "scripts",
  "qa",
  "eval-cases",
  "security-harness-regressions.json",
);

const HIGH_RISK_TARGETS = [
  { id: "tool-policy", pattern: /^src\/electron\/security\// },
  { id: "agent-tools", pattern: /^src\/electron\/agent\/tools\// },
  { id: "agent-runtime-policy", pattern: /^src\/electron\/agent\/runtime\/.*Policy/i },
  { id: "sandbox", pattern: /^src\/electron\/(agent\/)?sandbox\// },
  { id: "browser-automation", pattern: /^src\/electron\/browser\// },
  { id: "ipc-main", pattern: /^src\/electron\/.*(ipc|preload|main)\.(ts|tsx|js|mjs|cjs)$/i },
  { id: "connector-boundary", pattern: /^connectors\/[^/]+\/src\// },
  {
    id: "regression-policy",
    pattern: /^scripts\/qa\/(enforce_eval_regression_policy|security-harness)\.cjs$/,
  },
];

const SCANNER_RULES = [
  {
    id: "agent-shell-bypass",
    stage: "scan",
    severity: "critical",
    category: "tool_policy_bypass",
    summary: "Potential agent shell execution bypass",
    pattern: /\b(?:exec|execSync|spawn|spawnSync)\s*\(/,
    ignore: /execFileSync\(|ShellTools|run_command|ToolExecutionCoordinator|security-harness\.cjs/,
    remediation:
      "Route agent-initiated command execution through ShellTools and the policy/sandbox pipeline.",
    proofHint:
      "Add or run a regression that verifies policy evaluation fires before command execution.",
  },
  {
    id: "unsafe-ipc-path",
    stage: "scan",
    severity: "high",
    category: "ipc_input_validation",
    summary: "Renderer-controlled IPC path may need workspace validation",
    pattern: /\bipcMain\.(?:handle|on)\b.*(?:path|file|dir|workspace|taskId|workspaceId)/i,
    ignore: /checkProjectAccess|validate|SecurityPolicy|SecurityPolicyManager/,
    remediation:
      "Validate renderer-provided ids and paths with ownership/workspace checks before use.",
    proofHint:
      "Add an IPC test that attempts cross-workspace or traversal input and expects denial.",
  },
  {
    id: "secret-log-risk",
    stage: "scan",
    severity: "high",
    category: "credential_handling",
    summary: "Potential secret-bearing value logged or surfaced",
    pattern:
      /\b(?:console\.(?:log|warn|error)|logger\.(?:info|warn|error|debug))\b.*(?:token|secret|api[_-]?key|authorization|password)/i,
    ignore: /REDACTED|redact|redaction|sanitize/i,
    remediation:
      "Redact or omit credentials before logging, IPC responses, task events, and dev logs.",
    proofHint: "Add a log-redaction regression using a realistic token shape.",
  },
  {
    id: "data-export-classification-gap",
    stage: "scan",
    severity: "high",
    category: "data_export_policy",
    summary: "Outbound request path may bypass data_export classification",
    pattern: /\b(?:fetch|axios|http\.request|https\.request)\s*\(/,
    ignore: /data_export|classify|requiresApproval|web_fetch|http_request|security-harness\.cjs/,
    remediation:
      "Classify payload-carrying outbound requests as data_export and surface approval context.",
    proofHint: "Add a prompt-injection/data-export regression case for the request shape.",
  },
  {
    id: "path-traversal-boundary-gap",
    stage: "scan",
    severity: "medium",
    category: "file_access_boundary",
    summary: "Path composition near a boundary may need containment checks",
    pattern:
      /\bpath\.(?:join|resolve)\s*\([^)]*(?:input|payload|request|args|body|params|file|dir|path)/i,
    ignore:
      /checkProjectAccess|normalizeWorkspace|isPathInside|assert.*Path|DEFAULT_|path\.resolve\((rootAbs|rootDir)/,
    remediation:
      "Normalize and prove the resolved path remains inside the allowed workspace or temp root.",
    proofHint: "Add a traversal test with ../ and symlink-like path input.",
  },
  {
    id: "browser-rule-prefix-gap",
    stage: "scan",
    severity: "medium",
    category: "browser_permission_policy",
    summary: "Browser permission rule changes should cover tool-specific and prefix-scoped rules",
    pattern:
      /\b(?:browser_|web_fetch|http_request|domain|allowedDomains|permission rule|tool-prefix)\b/i,
    ignore: /browser_\*|toolName|toolPrefix|domain.*tool|security-harness\.cjs/,
    remediation:
      "Verify domain-scoped rules can target exact tool names and tool prefixes such as browser_*.",
    proofHint: "Add a policy regression for exact browser tool and browser_* prefix matching.",
  },
];

function normalizePath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function sha1(parts) {
  const hash = crypto.createHash("sha1");
  hash.update(parts.filter(Boolean).join("::"));
  return hash.digest("hex");
}

function parseArgs(argv) {
  const args = {
    base: process.env.COWORK_SECURITY_HARNESS_BASE || "HEAD~1",
    head: process.env.COWORK_SECURITY_HARNESS_HEAD || "HEAD",
    files: [],
    all: false,
    output: DEFAULT_REPORT_PATH,
    missionControlOut: DEFAULT_MISSION_CONTROL_PATH,
    dbPath: process.env.COWORK_DB_PATH || "",
    profileId: process.env.COWORK_SECURITY_HARNESS_PROFILE_ID || "",
    workspaceId: process.env.COWORK_SECURITY_HARNESS_WORKSPACE_ID || "",
    targetKey: process.env.COWORK_SECURITY_HARNESS_TARGET_KEY || "code_workspace:security",
    confirmedFix: process.env.COWORK_SECURITY_CONFIRMED_FIX === "1",
    fixId: process.env.COWORK_SECURITY_FIX_ID || "",
    fixSummary: process.env.COWORK_SECURITY_FIX_SUMMARY || "",
    evalCasePath: DEFAULT_EVAL_CASE_PATH,
    failOnFindings: process.env.COWORK_SECURITY_HARNESS_FAIL_ON_FINDINGS === "1",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base" && argv[index + 1]) args.base = String(argv[++index]);
    else if (arg === "--head" && argv[index + 1]) args.head = String(argv[++index]);
    else if (arg === "--files" && argv[index + 1]) {
      args.files = String(argv[++index])
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (arg === "--all") args.all = true;
    else if (arg === "--out" && argv[index + 1]) args.output = String(argv[++index]);
    else if (arg === "--mission-control-out" && argv[index + 1])
      args.missionControlOut = String(argv[++index]);
    else if (arg === "--db" && argv[index + 1]) args.dbPath = String(argv[++index]);
    else if (arg === "--profile-id" && argv[index + 1]) args.profileId = String(argv[++index]);
    else if (arg === "--workspace-id" && argv[index + 1]) args.workspaceId = String(argv[++index]);
    else if (arg === "--target-key" && argv[index + 1]) args.targetKey = String(argv[++index]);
    else if (arg === "--confirmed-fix") args.confirmedFix = true;
    else if (arg === "--fix-id" && argv[index + 1]) args.fixId = String(argv[++index]);
    else if (arg === "--fix-summary" && argv[index + 1]) args.fixSummary = String(argv[++index]);
    else if (arg === "--eval-case-path" && argv[index + 1])
      args.evalCasePath = String(argv[++index]);
    else if (arg === "--fail-on-findings") args.failOnFindings = true;
    else if (arg === "--no-fail-on-findings") args.failOnFindings = false;
  }

  return args;
}

function getChangedFiles(args) {
  if (args.files.length > 0) return args.files.map(normalizePath);
  const diffArgs = args.all ? ["ls-files"] : ["diff", "--name-only", `${args.base}...${args.head}`];
  const output = execFileSync("git", diffArgs, { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
}

function classifyHighRiskFile(filePath) {
  const normalized = normalizePath(filePath);
  const matches = HIGH_RISK_TARGETS.filter((target) => target.pattern.test(normalized)).map(
    (target) => target.id,
  );
  return {
    file: normalized,
    highRisk: matches.length > 0,
    reasons: matches,
  };
}

function readTextFile(filePath, rootDir = process.cwd()) {
  const rootAbs = path.resolve(rootDir);
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(rootAbs, filePath);
  if (!isPathInside(rootAbs, absolute)) return "";
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return "";
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return "";
  }
}

function isPathInside(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function makeCandidate({ rule, file, lineNumber, lineText, riskReasons }) {
  const normalizedLine = lineText.trim().replace(/\s+/g, " ").slice(0, 220);
  const fingerprint = sha1([rule.id, file, normalizedLine]);
  return {
    id: fingerprint,
    fingerprint,
    ruleId: rule.id,
    stage: rule.stage,
    severity: rule.severity,
    category: rule.category,
    file,
    line: lineNumber,
    summary: rule.summary,
    evidence: normalizedLine,
    riskReasons,
    remediation: rule.remediation,
    proofHint: rule.proofHint,
  };
}

function scanTextForCandidates(file, text, riskReasons = []) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const candidates = [];
  for (const rule of SCANNER_RULES) {
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index];
      if (
        file.endsWith("security-harness.cjs") &&
        /^\s*(pattern|ignore|summary|remediation|proofHint):/.test(lineText)
      ) {
        continue;
      }
      if (!rule.pattern.test(lineText)) continue;
      if (rule.ignore && rule.ignore.test(lineText)) continue;
      candidates.push(
        makeCandidate({
          rule,
          file,
          lineNumber: index + 1,
          lineText,
          riskReasons,
        }),
      );
    }
  }
  return candidates;
}

function validateCandidate(candidate) {
  const hasEvidence = Boolean(candidate.evidence && candidate.evidence.length >= 4);
  const hasBoundaryReason =
    Array.isArray(candidate.riskReasons) && candidate.riskReasons.length > 0;
  const hasStaticEvidence = hasEvidence && hasBoundaryReason;
  return {
    ...candidate,
    validation: {
      verifierRequired: true,
      verifierVerdict: "not_run",
      debaterRequired: true,
      debaterVerdict: "not_run",
      debaterCounterargument: null,
      proofRequired: true,
      proofStatus: "not_run",
      evidenceStatus: hasStaticEvidence ? "static_candidate" : "insufficient",
      proofHint: candidate.proofHint,
    },
    status: hasStaticEvidence ? "candidate" : "unverified",
  };
}

function dedupeFindings(candidates) {
  const byFingerprint = new Map();
  for (const candidate of candidates) {
    const existing = byFingerprint.get(candidate.fingerprint);
    if (!existing || candidate.line < existing.line) {
      byFingerprint.set(candidate.fingerprint, candidate);
    }
  }
  return Array.from(byFingerprint.values()).sort((a, b) => {
    const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
    return (
      (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
    );
  });
}

function buildReport({ args, changedFiles, highRiskFiles, candidates, findings, evalSync }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt: now,
    scope: {
      base: args.base,
      head: args.head,
      changedFileCount: changedFiles.length,
      highRiskFileCount: highRiskFiles.length,
      highRiskFiles,
    },
    pipeline: [
      {
        stage: "prepare",
        status: "completed",
        summary: "Changed files classified against CoWork high-risk boundaries.",
      },
      {
        stage: "scan",
        status: "completed",
        summary: `${candidates.length} auditor candidates produced.`,
      },
      {
        stage: "validate",
        status: "completed",
        summary:
          "Static candidate classification recorded; verifier, debater, and proof execution were not run.",
      },
      {
        stage: "dedup",
        status: "completed",
        summary: `${findings.length} deduped scanner candidate(s) emitted.`,
      },
      {
        stage: "prove",
        status: findings.length ? "pending" : "skipped",
        summary: findings.length
          ? "Candidates require an independent proof artifact before they can be marked confirmed."
          : "No scanner candidates require proof.",
      },
    ],
    findings,
    evalSync,
  };
}

function buildMissionControlPayload(report) {
  return {
    schemaVersion: 1,
    surface: "mission_control_core_harness",
    traceKind: "regression_eval",
    generatedAt: report.generatedAt,
    summary: `${report.findings.length} security harness candidate(s) across ${report.scope.highRiskFileCount} high-risk changed file(s).`,
    cards: report.findings.map((finding) => ({
      fingerprint: finding.fingerprint,
      status: finding.status,
      severity: finding.severity,
      category: finding.category,
      title: finding.summary,
      file: finding.file,
      line: finding.line,
      details: finding.evidence,
      remediation: finding.remediation,
      validation: finding.validation,
    })),
  };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeJsonRead(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function slugify(value) {
  return (
    String(value || "security-harness")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "security-harness"
  );
}

function syncConfirmedFixEvalFile({ args, findings }) {
  if (!args.confirmedFix) {
    return { enabled: false, path: args.evalCasePath, updated: false, categoryCount: 0 };
  }

  const existing = safeJsonRead(args.evalCasePath, {
    id: "security-harness-regressions-2026-05-14",
    title: "Security harness regression coverage",
    source: { incident: "security-harness", taskId: "security-harness" },
    categories: [],
    metrics: [
      "confirmed_security_findings_without_proof",
      "mission_control_security_finding_dedupe_rate",
      "security_eval_coverage_for_confirmed_fixes",
    ],
    notes: "Generated and maintained by npm run qa:security:harness -- --confirmed-fix.",
  });

  const categories = Array.isArray(existing.categories) ? existing.categories : [];
  const byId = new Map(categories.map((category) => [category.id, category]));
  const confirmedFindings = findings.filter((finding) => finding.status === "confirmed");
  const fixId = slugify(
    args.fixId ||
      args.fixSummary ||
      (confirmedFindings[0] && confirmedFindings[0].fingerprint) ||
      "confirmed-security-fix",
  );
  const sourceFindings =
    confirmedFindings.length > 0
      ? confirmedFindings
      : [
          {
            fingerprint: fixId,
            ruleId: "confirmed-fix",
            category: "production_policy",
            severity: "high",
            summary: args.fixSummary || "Confirmed security or production-policy fix",
            remediation: "Keep regression coverage for this confirmed fix.",
            proofHint:
              "Replay the original failure shape and assert the policy gate or denial still holds.",
          },
        ];

  for (const finding of sourceFindings) {
    const categoryId = slugify(`${fixId}-${finding.ruleId || finding.fingerprint}`);
    byId.set(categoryId, {
      id: categoryId,
      prompt: `Regression guard for ${finding.summary}: replay the original failure class and verify the fix still holds.`,
      assertions: {
        securityHarnessRule: finding.ruleId,
        expectedNoSilentBypass: true,
        expectedFindingFingerprint: finding.fingerprint,
        expectedPolicyGate: finding.category,
        requiresProofArtifact: true,
      },
    });
  }

  const next = {
    ...existing,
    source: {
      ...(existing.source || {}),
      incident: args.fixId || existing.source?.incident || "security-harness",
      taskId: args.fixId || existing.source?.taskId || "security-harness",
    },
    categories: Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id)),
  };
  writeJson(args.evalCasePath, next);
  return {
    enabled: true,
    path: args.evalCasePath,
    updated: true,
    categoryCount: next.categories.length,
  };
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function sqliteJson(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : [];
}

function sqliteExec(dbPath, sql) {
  execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
}

function syncMissionControlDb({ args, report }) {
  if (!args.dbPath || !args.profileId) {
    return {
      enabled: false,
      inserted: 0,
      reason: "Provide --db and --profile-id to write core trace/failure rows for Mission Control.",
    };
  }

  const profile = sqliteJson(
    args.dbPath,
    `SELECT id FROM automation_profiles WHERE id='${sqlEscape(args.profileId)}' LIMIT 1`,
  )[0];
  if (!profile) {
    return {
      enabled: true,
      inserted: 0,
      reason: `automation profile not found: ${args.profileId}`,
    };
  }

  const now = Date.now();
  const traceId = crypto.randomUUID();
  sqliteExec(
    args.dbPath,
    `INSERT INTO core_traces (
       id, profile_id, workspace_id, target_key, source_surface, trace_kind, status,
       summary, started_at, completed_at, created_at
     ) VALUES (
       '${sqlEscape(traceId)}',
       '${sqlEscape(args.profileId)}',
       ${args.workspaceId ? `'${sqlEscape(args.workspaceId)}'` : "NULL"},
       '${sqlEscape(args.targetKey)}',
       'trigger',
       'regression_eval',
       'completed',
       '${sqlEscape(`Security harness emitted ${report.findings.length} candidate(s).`)}',
       ${now},
       ${now},
       ${now}
     )`,
  );

  const events = report.pipeline.map((stage) => ({
    phase: stage.stage === "dedup" ? "failure_mining" : stage.stage,
    eventType: `security_harness_${stage.stage}`,
    summary: stage.summary,
  }));
  for (const event of events) {
    sqliteExec(
      args.dbPath,
      `INSERT INTO core_trace_events (id, trace_id, phase, event_type, summary, created_at)
       VALUES (
         '${crypto.randomUUID()}',
         '${sqlEscape(traceId)}',
         '${sqlEscape(event.phase)}',
         '${sqlEscape(event.eventType)}',
         '${sqlEscape(event.summary)}',
         ${now}
       )`,
    );
  }

  let inserted = 0;
  for (const finding of report.findings) {
    const existing = sqliteJson(
      args.dbPath,
      `SELECT id FROM core_failure_records
       WHERE profile_id='${sqlEscape(args.profileId)}'
         AND fingerprint='${sqlEscape(finding.fingerprint)}'
       LIMIT 1`,
    )[0];
    if (existing) continue;
    sqliteExec(
      args.dbPath,
      `INSERT INTO core_failure_records (
         id, trace_id, profile_id, workspace_id, target_key, category, severity, fingerprint,
         summary, details, status, source_surface, created_at
       ) VALUES (
         '${crypto.randomUUID()}',
         '${sqlEscape(traceId)}',
         '${sqlEscape(args.profileId)}',
         ${args.workspaceId ? `'${sqlEscape(args.workspaceId)}'` : "NULL"},
         '${sqlEscape(args.targetKey)}',
         'unknown',
         '${sqlEscape(finding.severity)}',
         '${sqlEscape(finding.fingerprint)}',
         '${sqlEscape(finding.summary)}',
         '${sqlEscape(JSON.stringify(finding))}',
         'open',
         'trigger',
         ${now}
       )`,
    );
    inserted += 1;
  }

  return { enabled: true, traceId, inserted, reason: inserted ? "inserted" : "deduped" };
}

function runHarness(args, rootDir = process.cwd()) {
  const changedFiles = getChangedFiles(args);
  const classified = changedFiles.map(classifyHighRiskFile);
  const highRiskFiles = classified.filter((item) => item.highRisk);
  const candidates = [];

  for (const target of highRiskFiles) {
    const text = readTextFile(target.file, rootDir);
    candidates.push(...scanTextForCandidates(target.file, text, target.reasons));
  }

  const validated = candidates.map(validateCandidate);
  // Keep static scanner candidates visible to Mission Control and blocking mode. A
  // candidate must retain status="candidate" until an independent proof stage has
  // actually run; the deterministic scanner cannot prove a security issue by itself.
  const findings = dedupeFindings(
    validated.filter((candidate) => ["candidate", "confirmed"].includes(candidate.status)),
  );
  const evalSync = syncConfirmedFixEvalFile({ args, findings });
  const report = buildReport({ args, changedFiles, highRiskFiles, candidates, findings, evalSync });
  const missionControl = buildMissionControlPayload(report);
  writeJson(args.output, report);
  writeJson(args.missionControlOut, missionControl);
  const dbSync = syncMissionControlDb({ args, report });
  report.missionControl = {
    artifactPath: args.missionControlOut,
    dbSync,
  };
  writeJson(args.output, report);

  return { report, missionControl };
}

function main() {
  const args = parseArgs(process.argv);
  const { report } = runHarness(args);
  console.log(`[security-harness] changed files: ${report.scope.changedFileCount}`);
  console.log(`[security-harness] high-risk files: ${report.scope.highRiskFileCount}`);
  console.log(`[security-harness] candidates: ${report.findings.length}`);
  console.log(`[security-harness] report: ${args.output}`);
  console.log(`[security-harness] mission-control artifact: ${args.missionControlOut}`);
  if (report.evalSync.enabled) {
    console.log(`[security-harness] eval case file updated: ${report.evalSync.path}`);
  }
  if (report.missionControl.dbSync.enabled) {
    console.log(
      `[security-harness] mission-control db sync: ${report.missionControl.dbSync.reason}`,
    );
  }

  const blocking = report.findings.filter((finding) =>
    ["critical", "high"].includes(finding.severity),
  );
  if (args.failOnFindings && blocking.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  HIGH_RISK_TARGETS,
  SCANNER_RULES,
  buildMissionControlPayload,
  buildReport,
  classifyHighRiskFile,
  dedupeFindings,
  isPathInside,
  parseArgs,
  runHarness,
  scanTextForCandidates,
  syncConfirmedFixEvalFile,
  validateCandidate,
};
