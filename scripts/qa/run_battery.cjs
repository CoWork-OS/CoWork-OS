/* eslint-disable no-console */
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const WebSocket = require("ws");

const {
  graderPrerequisites,
  verifyArtifact,
  ensureFile,
  hasQualifyingPdfMemoryBound,
} = require("./battery_artifact_graders.cjs");
const { startFixtureControlPlane } = require("./battery_fixture_control_plane.cjs");

const REPO_ROOT = path.resolve(__dirname, "../..");
const DAEMON_MAIN = path.join(REPO_ROOT, "dist", "daemon", "daemon", "main.js");
const DEFAULT_TASK_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_TOTAL_TIMEOUT_MS = 50 * 60 * 1000;
const DEFAULT_POLL_MS = 250;
const CLEANUP_TIMEOUT_MS = 5000;
const GRADER_TIMEOUT_MS = 15_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const WORKSPACE_ACCESS_PROFILE = "ask_for_approval";
const activeOwnedChildren = new Set();

function usage() {
  console.log(
    [
      "CoWork disposable eval battery",
      "",
      "Usage:",
      "  node scripts/qa/run_battery.cjs [--fixtures-only]",
      "  node scripts/qa/run_battery.cjs --live --allow-provider-calls --allow-network",
      "",
      "Default mode uses a fresh temporary profile/workspace and a local fixture Control Plane.",
      "It grades synthetic task outputs and does not measure agent capability.",
      "",
      "Live mode starts the built Node daemon in a fresh temporary profile and creates tasks",
      "through its authenticated local Control Plane. It may use provider/network services.",
      "Configure live providers with COWORK_QA_* variables; legacy COWORK_HOOKS_* and COWORK_DB_PATH do not select live mode or a database.",
      "",
      "",
      "Options:",
      "  --live                         Run the owned real daemon battery.",
      "  --fixtures-only                Run the bounded local fixture battery (default).",
      "  --allow-provider-calls         Required for live mode; permits configured provider calls.",
      "  --allow-network                Required for live mode; permits browser/search network tasks.",
      "  --approval-mode stop|allow-list  Default: stop.",
      "  --approve-type <exact-type>    Repeat to allow only these exact approval types.",
      "  --approval-scope workspace|domain:<host>  Required with allow-list; scopes repeat exactly.",
      "  --timeout-ms <n>               Per-task end-to-end deadline; default: 360000.",
      "  --total-timeout-ms <n>         Whole-battery deadline; default: 3000000.",
      "  --poll-ms <n>                  Poll interval; default: 250.",
      "  --profile-dir <path>           Optional new/empty directory under the OS temp directory.",
      "  --keep-profile                 Keep the disposable profile/workspace for inspection.",
      "  --json                         Print the complete result document as JSON.",
      "  --help                         Show this help.",
    ].join("\n"),
  );
}

function positiveInteger(value, label, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (max && parsed > max)) {
    throw new Error(label + " must be a positive integer" + (max ? " no greater than " + max : ""));
  }
  return parsed;
}

function parseArgs(argv) {
  let explicitMode;
  const options = {
    mode: "fixtures",
    allowProviderCalls: false,
    allowNetwork: false,
    approvalMode: "stop",
    approveTypes: new Set(),
    approvalScopes: new Set(),
    timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
    totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    profileDir: "",
    keepProfile: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (label) => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(label + " requires a value");
      index += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live" || arg === "--fixtures-only") {
      const requestedMode = arg === "--live" ? "live" : "fixtures";
      if (explicitMode && explicitMode !== requestedMode) {
        throw new Error("--live and --fixtures-only cannot be combined");
      }
      explicitMode = requestedMode;
      options.mode = requestedMode;
    } else if (arg === "--allow-provider-calls") options.allowProviderCalls = true;
    else if (arg === "--allow-network") options.allowNetwork = true;
    else if (arg === "--keep-profile") options.keepProfile = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--approval-mode") options.approvalMode = value(arg);
    else if (arg === "--approve-type") options.approveTypes.add(value(arg));
    else if (arg === "--approval-scope")
      options.approvalScopes.add(value(arg).trim().toLowerCase());
    else if (arg === "--timeout-ms")
      options.timeoutMs = positiveInteger(value(arg), arg, 30 * 60 * 1000);
    else if (arg === "--total-timeout-ms")
      options.totalTimeoutMs = positiveInteger(value(arg), arg, 4 * 60 * 60 * 1000);
    else if (arg === "--poll-ms") options.pollMs = positiveInteger(value(arg), arg, 10_000);
    else if (arg === "--profile-dir") options.profileDir = value(arg);
    else throw new Error("Unknown argument: " + arg);
  }
  if (!["stop", "allow-list"].includes(options.approvalMode)) {
    throw new Error("--approval-mode must be stop or allow-list");
  }
  if (options.approvalMode === "allow-list" && options.approveTypes.size === 0) {
    throw new Error("--approval-mode allow-list requires at least one --approve-type");
  }
  if (options.approvalMode === "allow-list" && options.approvalScopes.size === 0) {
    throw new Error("--approval-mode allow-list requires an explicit --approval-scope");
  }
  if (options.approvalMode !== "allow-list" && options.approvalScopes.size > 0) {
    throw new Error("--approval-scope requires --approval-mode allow-list");
  }
  for (const scope of options.approvalScopes) {
    if (scope !== "workspace" && !/^domain:[a-z0-9.-]+$/.test(scope)) {
      throw new Error("--approval-scope must be workspace or domain:<exact-hostname>");
    }
  }
  if (options.approveTypes.size > 0 && options.approvalMode !== "allow-list") {
    throw new Error("--approve-type requires --approval-mode allow-list");
  }
  if (options.mode === "live" && (!options.allowProviderCalls || !options.allowNetwork)) {
    throw new Error("--live requires both --allow-provider-calls and --allow-network");
  }
  if (options.profileDir && options.mode !== "live") {
    throw new Error("--profile-dir is only supported with --live");
  }
  return options;
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function createProfileDir(requestedPath, prefix) {
  if (!requestedPath) return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const target = path.resolve(requestedPath);
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (!isInside(tempRoot, target) || target === tempRoot) {
    throw new Error("Disposable profile must be a child of the OS temporary directory");
  }
  let realParent;
  try {
    realParent = fs.realpathSync(path.dirname(target));
  } catch {
    throw new Error(
      "Disposable profile parent must already exist inside the OS temporary directory",
    );
  }
  if (!isInside(tempRoot, realParent)) {
    throw new Error("Disposable profile parent must resolve inside the OS temporary directory");
  }
  const safeTarget = path.join(realParent, path.basename(target));
  try {
    if (fs.lstatSync(safeTarget).isSymbolicLink()) {
      throw new Error("Disposable profile directory cannot be a symbolic link");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(safeTarget, { mode: 0o700 });
  }
  const realTarget = fs.realpathSync(safeTarget);
  if (!isInside(tempRoot, realTarget) || realTarget === tempRoot) {
    throw new Error("Disposable profile must be a child of the OS temporary directory");
  }
  if (fs.readdirSync(realTarget).length > 0) {
    throw new Error("Disposable profile directory must be new or empty: " + realTarget);
  }
  return realTarget;
}

function checkModulePrerequisites(fixtures) {
  const prerequisites = graderPrerequisites({ fixtures });
  if (!prerequisites.ok) {
    throw new Error(
      "Required artifact grader modules are missing: " + prerequisites.missing.join(", "),
    );
  }
  return prerequisites;
}

function unescapeMountInfoPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function detectCgroupV2MemoryLimit(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") return { available: false, reason: "linux_required" };
  const readFileSync = options.readFileSync || fs.readFileSync;
  let cgroupText;
  let mountInfoText;
  try {
    cgroupText = readFileSync(options.procCgroupPath || "/proc/self/cgroup", "utf8");
    mountInfoText = readFileSync(options.procMountInfoPath || "/proc/self/mountinfo", "utf8");
  } catch {
    return { available: false, reason: "cgroup_metadata_unavailable" };
  }
  const membershipLine = String(cgroupText)
    .split(/\r?\n/)
    .find((line) => line.startsWith("0::"));
  if (!membershipLine) return { available: false, reason: "cgroup_v2_membership_missing" };
  const membershipPath = path.posix.normalize(membershipLine.slice(3));
  if (!membershipPath.startsWith("/")) {
    return { available: false, reason: "cgroup_v2_membership_invalid" };
  }

  const mounts = [];
  for (const line of String(mountInfoText).split(/\r?\n/)) {
    const [beforeSeparator, afterSeparator] = line.split(" - ", 2);
    if (!beforeSeparator || !afterSeparator) continue;
    const before = beforeSeparator.split(" ");
    const after = afterSeparator.split(" ");
    if (after[0] !== "cgroup2" || !before[3] || !before[4]) continue;
    mounts.push({
      root: path.posix.normalize(unescapeMountInfoPath(before[3])),
      mountPoint: path.posix.normalize(unescapeMountInfoPath(before[4])),
    });
  }
  for (const mount of mounts) {
    const relative = path.posix.relative(mount.root, membershipPath);
    if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative))
      continue;
    const leaf = path.posix.resolve(mount.mountPoint, relative);
    const relativeToMount = path.posix.relative(mount.mountPoint, leaf);
    if (relativeToMount === ".." || relativeToMount.startsWith("../")) continue;

    let current = leaf;
    let minimumBytes = Number.POSITIVE_INFINITY;
    let sawMemoryLimit = false;
    while (true) {
      let rawLimit;
      try {
        rawLimit = String(readFileSync(path.posix.join(current, "memory.max"), "utf8")).trim();
      } catch (error) {
        // The kernel root cgroup has no memory.max, so ENOENT at the cgroup2 mount root means
        // this level contributes no limit. (In a cgroup namespace the mount root is a non-root
        // cgroup whose memory.max exists and is read normally.)
        if (current === mount.mountPoint && error && error.code === "ENOENT") break;
        // Any other unreadable ancestor could impose a smaller limit, so fail closed.
        minimumBytes = Number.POSITIVE_INFINITY;
        break;
      }
      if (rawLimit !== "max") {
        if (!/^\d+$/.test(rawLimit)) {
          minimumBytes = Number.POSITIVE_INFINITY;
          break;
        }
        const bytes = Number(rawLimit);
        if (!Number.isSafeInteger(bytes) || bytes <= 0) {
          minimumBytes = Number.POSITIVE_INFINITY;
          break;
        }
        sawMemoryLimit = true;
        minimumBytes = Math.min(minimumBytes, bytes);
      }
      if (current === mount.mountPoint) break;
      const parent = path.posix.dirname(current);
      if (parent === current || !isInsidePosix(mount.mountPoint, parent)) {
        minimumBytes = Number.POSITIVE_INFINITY;
        break;
      }
      current = parent;
    }
    if (sawMemoryLimit && Number.isSafeInteger(minimumBytes)) {
      return {
        available: true,
        memoryLimitBytes: minimumBytes,
        source: "Linux cgroup v2 memory.max (minimum finite limit across inherited ancestors)",
      };
    }
  }
  return { available: false, reason: "finite_cgroup_v2_memory_limit_unavailable" };
}

function isInsidePosix(root, candidate) {
  const relative = path.posix.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("../") && relative !== ".." && !path.posix.isAbsolute(relative))
  );
}

function requireLivePdfMemoryBound(bound) {
  if (bound && bound.available && hasQualifyingPdfMemoryBound(bound.memoryLimitBytes)) return bound;
  throw new Error(
    "Full live mode is unavailable: live PDF parsing requires an inherited finite Linux cgroup v2 memory.max limit of 512 MiB or less. Run the battery in a bounded Linux container; synthetic PDF fixtures remain available on this platform.",
  );
}

function disposeProfileDir(profileDir, options = {}) {
  if (options.keepProfile) {
    return { attempted: false, failed: false, path: profileDir, disposition: "kept" };
  }
  if (!options.cleanupAllowed) {
    return {
      attempted: false,
      failed: false,
      path: profileDir,
      disposition: "retained because owned work remains unresolved",
    };
  }
  const remove = options.remove || fs.rmSync;
  const exists = options.exists || fs.existsSync;
  try {
    remove(profileDir, { recursive: true, force: true });
    if (exists(profileDir)) throw new Error("profile directory still exists after cleanup");
    return { attempted: true, failed: false, path: null, disposition: "cleaned after run" };
  } catch (error) {
    return {
      attempted: true,
      failed: true,
      path: profileDir,
      disposition: "retained because profile cleanup failed",
      error: errorText(error),
    };
  }
}

function withProfileCleanupError(error, profileDir, options = {}) {
  const wrapped = new Error(errorText(error));
  wrapped.profileCleanup = disposeProfileDir(profileDir, options);
  return wrapped;
}

function detectRenderers() {
  const find = (name) => {
    try {
      return (
        spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], {
          encoding: "utf8",
          timeout: 1500,
          windowsHide: true,
        }).status === 0
      );
    } catch {
      return false;
    }
  };
  return {
    pdfRasterizer: find("pdftoppm")
      ? "available; not invoked (PDF.js semantic checks used)"
      : "unavailable; PDF.js text/page checks used",
    officeRenderer:
      find("soffice") || find("libreoffice")
        ? "available; not invoked (OOXML semantic checks used)"
        : "unavailable; JSZip/ExcelJS semantic checks used",
  };
}

function readText(absPath) {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch (error) {
    return { error: "read_failed", detail: errorText(error) };
  }
}

function verifyExactText(absPath, expected) {
  const file = ensureFile(absPath);
  if (!file.ok) return file;
  const content = readText(absPath);
  if (typeof content !== "string") return content;
  return content.trim() === expected
    ? { ok: true, semanticCheck: "exact UTF-8 text read-back" }
    : { ok: false, error: "content_mismatch", content: content.slice(0, 500) };
}

function verifyBrowserTitle(absPath) {
  const file = ensureFile(absPath);
  if (!file.ok) return file;
  const content = readText(absPath);
  if (typeof content !== "string") return content;
  return /example domain/i.test(content)
    ? { ok: true, semanticCheck: "page title read-back" }
    : { ok: false, error: "unexpected_title", content: content.slice(0, 300) };
}

function verifySearchSummary(absPath) {
  const file = ensureFile(absPath);
  if (!file.ok) return file;
  const content = readText(absPath);
  if (typeof content !== "string") return content;
  const bullets = content.split(/\r?\n/).filter((line) => /^\s*[-*]\s+/.test(line));
  if (bullets.length < 5)
    return { ok: false, error: "fewer_than_five_bullets", count: bullets.length };
  if (!/typescript\s*5\.7/i.test(content))
    return { ok: false, error: "typescript_version_missing" };
  return {
    ok: true,
    bullets: bullets.length,
    semanticCheck: "five-bullet topical summary read-back",
  };
}

function createScenarios(runId) {
  const hello = "hello from battery " + runId;
  return [
    {
      name: "qa-battery-" + runId + "-hello",
      outRel: "battery_" + runId + "_hello.txt",
      message:
        "Create a text file named battery_" +
        runId +
        "_hello.txt in the current workspace containing exactly: " +
        hello,
      fixture: { kind: "text", content: hello },
      verify: (abs) => verifyExactText(abs, hello),
    },
    {
      name: "qa-battery-" + runId + "-browser",
      outRel: "battery_" + runId + "_example_title.txt",
      message:
        "Use the browser tool to open https://example.com and write ONLY the page title into battery_" +
        runId +
        "_example_title.txt.",
      fixture: { kind: "browser" },
      liveToolEvidence: { tool: "browser_navigate", targetUrl: "https://example.com/" },
      verify: verifyBrowserTitle,
    },
    {
      name: "qa-battery-" + runId + "-web-search",
      outRel: "battery_" + runId + "_ts57_web_search.md",
      message:
        'Use web_search for: "TypeScript 5.7 new features". Write a short 5-bullet summary to battery_' +
        runId +
        "_ts57_web_search.md.",
      fixture: { kind: "search" },
      liveToolEvidence: { tool: "web_search", query: "TypeScript 5.7 new features" },
      verify: verifySearchSummary,
    },
    {
      name: "qa-battery-" + runId + "-spreadsheet",
      outRel: "battery_" + runId + "_formula.xlsx",
      message:
        "Create an xlsx named battery_" +
        runId +
        '_formula.xlsx in the current workspace. Sheet1: A1="A", B1="B", C1="Sum"; A2=2, B2=3; C2 must be a real Excel formula =A2+B2 with calculated result 5. Save it.',
      fixture: { kind: "xlsx" },
      artifactKind: "xlsx",
      verify: (abs) => verifyArtifact("xlsx", abs, runId),
    },
    {
      name: "qa-battery-" + runId + "-pdf",
      outRel: "battery_" + runId + "_report.pdf",
      message:
        "Create a one-page PDF named battery_" +
        runId +
        '_report.pdf. Include the title "QA Battery Report" and this run id: ' +
        runId +
        ".",
      fixture: { kind: "pdf", runId },
      artifactKind: "pdf",
      verify: (abs) => verifyArtifact("pdf", abs, runId),
    },
    {
      name: "qa-battery-" + runId + "-pptx",
      outRel: "battery_" + runId + "_deck.pptx",
      message:
        "Create a PPTX named battery_" +
        runId +
        '_deck.pptx with exactly 2 slides: slide 1 has title "QA Battery" and run id ' +
        runId +
        "; slide 2 has 3 actual bullets: One, Two, Three.",
      fixture: { kind: "pptx", runId },
      artifactKind: "pptx",
      verify: (abs) => verifyArtifact("pptx", abs, runId),
    },
    {
      name: "qa-battery-" + runId + "-run-command",
      outRel: path.join(".tmp", "qa-workspace", "battery_" + runId + "_node_version.txt"),
      message:
        "Run the shell command: node -v. Write the output into .tmp/qa-workspace/battery_" +
        runId +
        "_node_version.txt and then stop.",
      fixture: { kind: "text", content: process.version },
      liveToolEvidence: { tool: "run_command", command: "node -v" },
      verify: (abs) => {
        const file = ensureFile(abs);
        if (!file.ok) return file;
        const content = readText(abs);
        if (typeof content !== "string") return content;
        return /^v\d+\./.test(content.trim())
          ? { ok: true, semanticCheck: "Node version output read-back" }
          : { ok: false, error: "unexpected_node_version", content: content.slice(0, 100) };
      },
    },
    {
      name: "qa-battery-" + runId + "-followup",
      outRel: "battery_" + runId + "_followup.txt",
      message: "Create battery_" + runId + "_followup.txt with exactly one line: line1",
      followUp: 'Append a second line "line2" to battery_' + runId + "_followup.txt",
      fixture: { kind: "text", content: "line1" },
      verify: (abs) => {
        const file = ensureFile(abs);
        if (!file.ok) return file;
        const content = readText(abs);
        if (typeof content !== "string") return content;
        const lines = content.trim().split(/\r?\n/);
        return lines.length >= 2 && lines[0] === "line1" && lines[1] === "line2"
          ? { ok: true, semanticCheck: "two-line follow-up read-back" }
          : { ok: false, error: "followup_content_mismatch", content: content.slice(0, 200) };
      },
    },
  ];
}

function resolveWorkspaceOutput(workspacePath, outRel) {
  if (path.isAbsolute(outRel)) return { error: "absolute_output_path_rejected" };
  const absPath = path.resolve(workspacePath, outRel);
  if (!isInside(workspacePath, absPath)) return { error: "output_path_escapes_workspace" };
  let current = workspacePath;
  const relative = path.relative(workspacePath, absPath);
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return { error: "symlink_output_path_rejected" };
    } catch (error) {
      if (error.code !== "ENOENT")
        return { error: "output_path_stat_failed", detail: errorText(error) };
    }
  }
  return { absPath };
}

function approvalPaths(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const allowedKeys = new Set([
    "path",
    "requestedPath",
    "filePath",
    "targetPath",
    "paths",
    "pathOperations",
    "operation",
    "toolName",
    "label",
    "kind",
  ]);
  if (Object.keys(details).some((key) => !allowedKeys.has(key))) return [];
  const paths = [];
  const defaultOperation = details.operation;
  const pushPath = (rawPath, operation) => {
    if (typeof rawPath !== "string" || !rawPath.trim() || !["read", "write"].includes(operation))
      return false;
    paths.push({ path: rawPath.trim(), operation });
    return true;
  };
  for (const key of ["path", "requestedPath", "filePath", "targetPath"]) {
    if (details[key] !== undefined && !pushPath(details[key], defaultOperation)) return [];
  }
  for (const key of ["paths", "pathOperations"]) {
    if (!Array.isArray(details[key])) continue;
    for (const item of details[key]) {
      if (typeof item === "string") {
        if (!pushPath(item, defaultOperation)) return [];
      } else if (item && typeof item.path === "string") {
        if (!pushPath(item.path, item.operation)) return [];
      } else return [];
    }
  }
  return paths;
}

function isApprovalInWorkspace(approval, { taskId, workspacePath }) {
  if (!approval || approval.taskId !== taskId) return false;
  const paths = approvalPaths(approval.details);
  return (
    paths.length > 0 &&
    paths.every(({ path: candidate }) => {
      const absPath = path.resolve(workspacePath, candidate);
      if (!isInside(workspacePath, absPath)) return false;
      let current = workspacePath;
      for (const segment of path.relative(workspacePath, absPath).split(path.sep)) {
        if (!segment) continue;
        current = path.join(current, segment);
        try {
          if (fs.lstatSync(current).isSymbolicLink()) return false;
        } catch (error) {
          if (error.code !== "ENOENT") return false;
        }
      }
      return true;
    })
  );
}

function isApprovalForDomain(approval, hostname) {
  const details = approval && approval.details;
  if (!details || details.kind !== "browser_use_domain_access" || typeof details.url !== "string")
    return false;
  try {
    const url = new URL(details.url);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.toLowerCase() === hostname &&
      String(details.domain || "").toLowerCase() === hostname &&
      String(details.origin || "") === url.origin
    );
  } catch {
    return false;
  }
}

function isApprovalInScope(approval, { taskId, workspacePath, approvalScopes }) {
  if (!approval || approval.taskId !== taskId || !(approvalScopes instanceof Set)) return false;
  if (approvalScopes.has("workspace") && isApprovalInWorkspace(approval, { taskId, workspacePath }))
    return true;
  for (const scope of approvalScopes) {
    if (!scope.startsWith("domain:")) continue;
    if (isApprovalForDomain(approval, scope.slice("domain:".length))) return true;
  }
  return false;
}

async function runBoundedGrader(kind, artifactPath, runId, deadlineAt, options = {}) {
  if (
    kind === "pdf" &&
    options.mode === "live" &&
    !hasQualifyingPdfMemoryBound(options.pdfMemoryLimitBytes)
  ) {
    return { ok: false, error: "pdf_memory_bound_unavailable" };
  }
  const remaining = Math.min(GRADER_TIMEOUT_MS, deadlineAt - Date.now());
  if (remaining <= 0) return { ok: false, error: "grader_deadline_exceeded" };
  const workerPath = path.join(__dirname, "battery_artifact_grader_worker.cjs");
  const workerOptions = {
    mode: options.mode === "fixtures" ? "fixtures" : "live",
    pdfMemoryLimitBytes: options.pdfMemoryLimitBytes,
  };
  const child = spawn(
    process.execPath,
    [workerPath, JSON.stringify({ kind, path: artifactPath, runId, options: workerOptions })],
    {
      cwd: os.tmpdir(),
      env: Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      ),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  child.qaKnownLeafProcess = true;
  activeOwnedChildren.add(child);
  const stdoutChunks = [];
  let stdoutBytes = 0;
  let stderr = "";
  let tooMuchOutput = false;
  let resolveOutputLimit;
  const outputLimitExceeded = new Promise((resolve) => {
    resolveOutputLimit = resolve;
  });
  const maxStdoutBytes = 128 * 1024;
  child.stdout.on("data", (chunk) => {
    if (tooMuchOutput) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remainingBytes = Math.max(0, maxStdoutBytes - stdoutBytes);
    if (remainingBytes > 0) stdoutChunks.push(Buffer.from(bytes.subarray(0, remainingBytes)));
    stdoutBytes += bytes.length;
    if (stdoutBytes > maxStdoutBytes) {
      tooMuchOutput = true;
      signalOwnedProcessTree(child, "SIGTERM");
      resolveOutputLimit({ outputLimitExceeded: true });
    }
  });
  child.stderr.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderr = Buffer.concat([Buffer.from(stderr), bytes])
      .subarray(-4096)
      .toString("utf8");
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), remaining);
  });
  try {
    const outcome = await Promise.race([exited, timedOut, outputLimitExceeded]);
    if (outcome.timedOut || tooMuchOutput) {
      const graceful = signalOwnedProcessTree(child, "SIGTERM");
      let processStopped = await waitProcessTreeExit(child, 750, {
        windowsTreeKillAcknowledged: process.platform === "win32" && graceful,
      });
      if (!processStopped) {
        const forced = signalOwnedProcessTree(child, "SIGKILL");
        processStopped = await waitProcessTreeExit(child, 1000, {
          windowsTreeKillAcknowledged: process.platform === "win32" && forced,
        });
      }
      return {
        ok: false,
        error: outcome.timedOut ? "grader_timeout" : "grader_output_limit",
        processStopped,
        ...(processStopped
          ? {}
          : { unresolvedOwnedProcess: { pid: child.pid, processGroupId: child.pid } }),
        ...(graceful ? {} : { terminationSignalFailed: true }),
      };
    }
    if (outcome.code !== 0) {
      return {
        ok: false,
        error: "grader_process_failed",
        exitCode: outcome.code,
        signal: outcome.signal,
        detail: stderr.slice(-1000),
      };
    }
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    try {
      return JSON.parse(stdout);
    } catch {
      return {
        ok: false,
        error: "grader_invalid_output",
        output: stdout.slice(0, 500),
        detail: stderr.slice(-1000),
      };
    }
  } finally {
    clearTimeout(timer);
    if (await waitProcessTreeExit(child, 1, { knownLeaf: true })) activeOwnedChildren.delete(child);
  }
}

class BoundedControlPlaneClient {
  constructor({ url, token, deviceName }) {
    this.url = url;
    this.token = token;
    this.deviceName = deviceName || "cowork-qa-battery";
    this.ws = null;
    this.pending = new Map();
  }

  async connect(deadlineAt) {
    const remaining = Math.max(0, deadlineAt - Date.now());
    if (remaining <= 0) throw new Error("deadline exceeded before Control Plane connect");
    const ws = new WebSocket(this.url, { handshakeTimeout: remaining });
    this.ws = ws;
    const failPending = (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        // A lost connection after a mutation request has an uncertain outcome.
        error.uncertainDispatch = true;
        pending.reject(error);
      }
      this.pending.clear();
    };
    ws.on("error", failPending);
    ws.on("close", () => failPending(new Error("Control Plane connection closed")));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        ws.terminate();
        reject(new Error("Control Plane connection deadline exceeded"));
      }, remaining);
      const cleanup = () => {
        clearTimeout(timeout);
        ws.off("open", onOpen);
        ws.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (frame.type !== "res" || typeof frame.id !== "string") return;
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) pending.resolve(frame.payload);
      else {
        const error = new Error(
          frame.error && frame.error.message ? frame.error.message : "Control Plane request failed",
        );
        error.code = frame.error && frame.error.code;
        pending.reject(error);
      }
    });
    await this.request("connect", { token: this.token, deviceName: this.deviceName }, deadlineAt);
  }

  request(method, params, deadlineAt) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Control Plane is not connected"));
    const remaining = Math.floor(deadlineAt - Date.now());
    if (remaining <= 0) return Promise.reject(new Error("deadline exceeded before " + method));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error("deadline exceeded during " + method);
        error.deadlineExceeded = true;
        reject(error);
      }, remaining);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(
        JSON.stringify({ type: "req", id, method, ...(params === undefined ? {} : { params }) }),
        (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        },
      );
    });
  }

  close() {
    if (!this.ws) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Control Plane connection closed"));
    }
    this.pending.clear();
    this.ws.close();
    this.ws = null;
  }
}

async function pollTask(client, taskId, deadlineAt, pollMs) {
  while (Date.now() < deadlineAt) {
    const payload = await client.request("task.get", { taskId }, deadlineAt);
    const task = payload && payload.task;
    if (!task) return { ok: false, reason: "task_not_found" };
    if (TERMINAL_STATUSES.has(task.status)) return { ok: true, task };
    await sleep(Math.min(pollMs, Math.max(0, deadlineAt - Date.now())));
  }
  return { ok: false, reason: "timeout" };
}

async function waitForTerminalStatus(client, taskId, options) {
  const deadlineAt = options.deadlineAt;
  const pollMs = options.pollMs || DEFAULT_POLL_MS;
  const approvalMode = options.approvalMode || "stop";
  const approveTypes = options.approveTypes || new Set();
  const respondedIds = new Set();
  while (Date.now() < deadlineAt) {
    const taskPayload = await client.request("task.get", { taskId }, deadlineAt);
    const task = taskPayload && taskPayload.task;
    if (!task) return { ok: false, reason: "task_not_found" };
    const approvalPayload = await client.request(
      "approval.list",
      { taskId, limit: 100, offset: 0 },
      deadlineAt,
    );
    const pending = (
      approvalPayload && Array.isArray(approvalPayload.approvals) ? approvalPayload.approvals : []
    ).filter((approval) => approval && approval.status === "pending");
    const approvalScopes = options.approvalScopes || new Set();
    const workspacePath = options.workspacePath || "";
    const blocked = pending.filter((approval) => {
      return (
        approvalMode !== "allow-list" ||
        approval.taskId !== taskId ||
        !approveTypes.has(approval.type) ||
        !isApprovalInScope(approval, { taskId, workspacePath, approvalScopes })
      );
    });
    if (blocked.length > 0) {
      return {
        ok: false,
        reason: "pending_approval",
        approvals: blocked.map(({ id, type, description }) => ({ id, type, description })),
        task,
      };
    }
    for (const approval of pending) {
      if (respondedIds.has(approval.id)) continue;
      if (
        typeof approval.revisionHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(approval.revisionHash)
      ) {
        return {
          ok: false,
          reason: "approval_revision_missing",
          approvalId: approval.id,
          task,
        };
      }
      const response = await client.request(
        "approval.respond",
        {
          approvalId: approval.id,
          expectedRevisionHash: approval.revisionHash,
          approved: true,
        },
        deadlineAt,
      );
      if (
        response &&
        response.status &&
        !["approved", "handled", "duplicate"].includes(response.status)
      ) {
        return {
          ok: false,
          reason: "approval_response_failed",
          approvalId: approval.id,
          status: response.status,
          task,
        };
      }
      respondedIds.add(approval.id);
    }
    if (TERMINAL_STATUSES.has(task.status)) return { ok: true, task };
    await sleep(Math.min(pollMs, Math.max(0, deadlineAt - Date.now())));
  }
  return { ok: false, reason: "timeout" };
}

async function cancelAndObserve(client, taskId, timeoutMs = CLEANUP_TIMEOUT_MS, pollMs = 100) {
  const deadlineAt = Date.now() + timeoutMs;
  let cancelResponse;
  let cancelError;
  try {
    cancelResponse = await client.request("task.cancel", { taskId }, deadlineAt);
  } catch (error) {
    cancelError = errorText(error);
  }
  const observed = await pollTask(client, taskId, deadlineAt, pollMs).catch((error) => ({
    ok: false,
    reason: error && error.deadlineExceeded ? "cleanup_deadline" : "task_status_unavailable",
    detail: errorText(error),
  }));
  return {
    cancelRequested: !cancelError,
    cancelResponse: cancelResponse || null,
    cancelError: cancelError || null,
    status: observed.ok ? observed.task.status : null,
    resolved: observed.ok,
    unresolvedOwnedTask: observed.ok
      ? null
      : { taskId, reason: observed.reason, detail: observed.detail || null },
  };
}

async function taskIdsForWorkspace(client, workspaceId, deadlineAt) {
  const payload = await client.request(
    "task.list",
    { workspaceId, limit: 500, offset: 0 },
    deadlineAt,
  );
  return (payload && Array.isArray(payload.tasks) ? payload.tasks : [])
    .map((task) => task.id)
    .filter(Boolean);
}

async function recoverTimedOutCreate(
  client,
  scenario,
  workspaceId,
  beforeIds,
  profileDir,
  runtimePid,
) {
  const deadlineAt = Date.now() + CLEANUP_TIMEOUT_MS;
  let found = [];
  try {
    const currentIds = await taskIdsForWorkspace(client, workspaceId, deadlineAt);
    const newIds = currentIds.filter((id) => !beforeIds.has(id));
    const payloads = await Promise.all(
      newIds.map((taskId) => client.request("task.get", { taskId }, deadlineAt)),
    );
    found = payloads
      .map((item) => item && item.task)
      .filter((task) => task && task.title === scenario.name);
  } catch {
    found = [];
  }
  const cleanup = [];
  for (const task of found)
    cleanup.push({ taskId: task.id, ...(await cancelAndObserve(client, task.id)) });
  return {
    uncertainDispatch: true,
    recoveredTaskIds: found.map((task) => task.id),
    cleanup,
    unresolvedOwnedWork: {
      stage: "task.create",
      title: scenario.name,
      profileDir,
      runtimePid: runtimePid || null,
      reason:
        "task.create response was not confirmed; task identity could not be safely established",
    },
  };
}

// task.events returns timeline-v2 rows: legacy follow_up_completed is stored as a timeline_*
// type (timeline_step_updated) with the legacy name in payload.legacyType.
function isFollowUpCompletedEvent(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "follow_up_completed") return true;
  return (
    typeof item.type === "string" &&
    item.type.startsWith("timeline_") &&
    !!item.payload &&
    typeof item.payload === "object" &&
    item.payload.legacyType === "follow_up_completed"
  );
}

async function waitForFollowUp(client, taskId, priorEventIds, deadlineAt, pollMs) {
  while (Date.now() < deadlineAt) {
    const payload = await client.request("task.events", { taskId, limit: 500 }, deadlineAt);
    const events = payload && Array.isArray(payload.events) ? payload.events : [];
    const event = events.find(
      (item) => isFollowUpCompletedEvent(item) && !priorEventIds.has(item.id),
    );
    if (event) return { ok: true, event };
    const taskPayload = await client.request("task.get", { taskId }, deadlineAt);
    const task = taskPayload && taskPayload.task;
    if (task && ["failed", "cancelled"].includes(task.status)) {
      return { ok: false, reason: "followup_task_" + task.status, task };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadlineAt - Date.now())));
  }
  return { ok: false, reason: "timeout" };
}

function normalizedQuery(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

const BROADCAST_TRUNCATION_MARKER = "[... truncated ...]";

function normalizedHttpUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function toolCallMatchesEvidence(requirement, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (requirement.tool === "browser_navigate") {
    return normalizedHttpUrl(input.url) === normalizedHttpUrl(requirement.targetUrl);
  }
  if (requirement.tool === "web_search") {
    return normalizedQuery(input.query) === normalizedQuery(requirement.query);
  }
  if (requirement.tool === "run_command") {
    return typeof input.command === "string" && input.command.trim() === requirement.command;
  }
  return false;
}

function normalizeToolEvent(event) {
  if (!event || typeof event !== "object" || !event.payload || typeof event.payload !== "object") {
    return null;
  }
  if (["tool_call", "tool_result", "tool_error"].includes(event.type)) {
    return { type: event.type, payload: event.payload };
  }
  if (typeof event.type === "string" && event.type.startsWith("timeline_")) {
    const legacyType = event.payload.legacyType;
    if (["tool_call", "tool_result", "tool_error"].includes(legacyType)) {
      return { type: legacyType, payload: event.payload };
    }
  }
  return null;
}

function successfulToolResult(requirement, result, envelope) {
  if (!result || typeof result !== "object") return false;
  if (result.success === false || (envelope && envelope.status && envelope.status !== "success")) {
    return false;
  }
  const succeeded = result.success === true || (envelope && envelope.status === "success");
  if (!succeeded) return false;
  if (requirement.tool === "browser_navigate") {
    return (
      normalizedHttpUrl(result.url) === normalizedHttpUrl(requirement.targetUrl) &&
      typeof result.title === "string" &&
      result.title.trim().length > 0
    );
  }
  if (requirement.tool === "web_search") {
    const hasUsableHit =
      Array.isArray(result.results) &&
      result.results.some(
        (hit) =>
          hit &&
          typeof hit === "object" &&
          typeof hit.title === "string" &&
          hit.title.trim().length > 0 &&
          // task.events passes payloads through sanitizeForBroadcast (MAX_BROADCAST_DEPTH = 3),
          // which replaces payload.result.results[i].url (depth 4) with this marker, so the
          // marker is accepted alongside a real http(s) URL.
          (normalizedHttpUrl(hit.url) || hit.url === BROADCAST_TRUNCATION_MARKER) &&
          typeof (hit.snippet || hit.content) === "string" &&
          String(hit.snippet || hit.content).trim().length > 0,
      );
    return normalizedQuery(result.query) === normalizedQuery(requirement.query) && hasUsableHit;
  }
  if (requirement.tool === "run_command") {
    return (
      result.exitCode === 0 &&
      result.terminationReason === "normal" &&
      typeof result.stdout === "string" &&
      /^v\d+\.\d+\.\d+(?:[-+][^\s]+)?\s*$/.test(result.stdout)
    );
  }
  return false;
}

function verifyToolEvidenceFromEvents(events, requirement) {
  if (!Array.isArray(events) || !requirement || typeof requirement.tool !== "string") {
    return { ok: false, error: "tool_event_trace_invalid" };
  }
  const normalized = events.map(normalizeToolEvent).filter(Boolean);
  const calls = normalized.filter(
    (event) =>
      event.type === "tool_call" &&
      event.payload.tool === requirement.tool &&
      toolCallMatchesEvidence(requirement, event.payload.input),
  );
  if (calls.length === 0) return { ok: false, error: "required_tool_call_missing_or_mismatched" };
  for (const call of calls) {
    const useId = call.payload.toolUseId;
    if (typeof useId !== "string" || !useId) continue;
    const failed = normalized.some(
      (event) => event.type === "tool_error" && event.payload.toolUseId === useId,
    );
    if (failed) continue;
    const resultEvent = normalized.find(
      (event) =>
        event.type === "tool_result" &&
        event.payload.tool === requirement.tool &&
        event.payload.toolUseId === useId,
    );
    if (
      !resultEvent ||
      !successfulToolResult(requirement, resultEvent.payload.result, resultEvent.payload.envelope)
    ) {
      continue;
    }
    const result = resultEvent.payload.result;
    return {
      ok: true,
      tool: requirement.tool,
      toolUseId: useId,
      ...(requirement.tool === "browser_navigate" || requirement.tool === "run_command"
        ? {
            expectedArtifactContent: String(
              requirement.tool === "browser_navigate" ? result.title : result.stdout,
            ).trim(),
          }
        : {}),
    };
  }
  return { ok: false, error: "required_tool_result_missing_or_failed" };
}

async function verifyLiveToolEvidence(client, taskId, requirement, deadlineAt) {
  let response;
  try {
    response = await client.request("task.events", { taskId, limit: 2000 }, deadlineAt);
  } catch (error) {
    return { ok: false, error: "tool_event_trace_unavailable", detail: errorText(error) };
  }
  return verifyToolEvidenceFromEvents(response && response.events, requirement);
}

async function runScenario(client, scenario, options) {
  const startedAt = Date.now();
  const totalDeadlineAt = Number.isFinite(options.totalDeadlineAt)
    ? options.totalDeadlineAt
    : startedAt + (options.totalTimeoutMs || DEFAULT_TOTAL_TIMEOUT_MS);
  const deadlineAt = Math.min(totalDeadlineAt, startedAt + options.timeoutMs);
  if (deadlineAt <= Date.now())
    return {
      name: scenario.name,
      ok: false,
      phase: "deadline",
      reason: "battery_deadline_exceeded",
    };
  let beforeIds = new Set();
  try {
    beforeIds = new Set(await taskIdsForWorkspace(client, options.workspaceId, deadlineAt));
  } catch {
    // The create request remains bounded and its failure is reported below.
  }

  const createParams = {
    title: scenario.name,
    prompt: scenario.message,
    workspaceId: options.workspaceId,
  };
  if (options.mode === "live") {
    createParams.agentConfig = { accessProfileId: WORKSPACE_ACCESS_PROFILE };
  }
  if (options.mode === "fixtures") {
    createParams.batteryFixture = {
      ...scenario.fixture,
      outRel: scenario.outRel,
      runId: options.runId,
      ...(scenario.fixture && scenario.fixture.kind === "hang" ? { kind: "hang" } : {}),
    };
  }
  let createResult;
  try {
    createResult = await client.request("task.create", createParams, deadlineAt);
  } catch (error) {
    const uncertain =
      error && (error.deadlineExceeded || error.uncertainDispatch)
        ? await recoverTimedOutCreate(
            client,
            scenario,
            options.workspaceId,
            beforeIds,
            options.profileDir,
            options.runtimePid,
          )
        : null;
    return {
      name: scenario.name,
      ok: false,
      phase: "trigger",
      reason: errorText(error),
      ...(uncertain
        ? { recovery: uncertain, unresolvedOwnedWork: uncertain.unresolvedOwnedWork }
        : {}),
      durationMs: Date.now() - startedAt,
    };
  }
  const task = createResult && createResult.task;
  const taskId = (task && task.id) || (createResult && createResult.taskId);
  if (!taskId) {
    return {
      name: scenario.name,
      ok: false,
      phase: "trigger",
      reason: "task.create returned no task id",
      response: createResult || null,
      durationMs: Date.now() - startedAt,
    };
  }

  let wait;
  try {
    wait = await waitForTerminalStatus(client, taskId, {
      deadlineAt,
      pollMs: options.pollMs,
      approvalMode: options.approvalMode,
      approveTypes: options.approveTypes,
      approvalScopes: options.approvalScopes,
      workspacePath: options.workspacePath,
    });
  } catch (error) {
    wait = {
      ok: false,
      reason: error && error.deadlineExceeded ? "timeout" : "control_plane_error",
      detail: errorText(error),
    };
  }
  if (!wait.ok) {
    const cleanup = await cancelAndObserve(client, taskId);
    return {
      name: scenario.name,
      ok: false,
      phase: "wait",
      taskId,
      reason: wait.reason,
      approvals: wait.approvals || [],
      error: wait.detail || null,
      cleanup,
      unresolvedOwnedWork: cleanup.unresolvedOwnedTask
        ? {
            ...cleanup.unresolvedOwnedTask,
            profileDir: options.profileDir,
            runtimePid: options.runtimePid || null,
          }
        : null,
      durationMs: Date.now() - startedAt,
    };
  }

  if (wait.task.status !== "completed" || wait.task.error) {
    return {
      name: scenario.name,
      ok: false,
      phase: "task",
      taskId,
      status: wait.task.status,
      error: wait.task.error || null,
      durationMs: Date.now() - startedAt,
    };
  }

  let liveToolEvidence;
  if (options.mode === "live" && scenario.liveToolEvidence) {
    liveToolEvidence = await verifyLiveToolEvidence(
      client,
      taskId,
      scenario.liveToolEvidence,
      deadlineAt,
    );
    if (!liveToolEvidence.ok) {
      return {
        name: scenario.name,
        ok: false,
        phase: "tool_evidence",
        taskId,
        status: wait.task.status,
        verify: liveToolEvidence,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  const output = resolveWorkspaceOutput(options.workspacePath, scenario.outRel);
  let verify;
  if (!output.absPath) verify = { ok: false, error: output.error, detail: output.detail };
  else {
    try {
      verify = ["pdf", "pptx", "xlsx"].includes(scenario.artifactKind)
        ? await runBoundedGrader(scenario.artifactKind, output.absPath, options.runId, deadlineAt, {
            mode: options.mode,
            pdfMemoryLimitBytes: options.pdfMemoryLimitBytes,
          })
        : await scenario.verify(output.absPath);
      if (
        verify.ok &&
        liveToolEvidence &&
        typeof liveToolEvidence.expectedArtifactContent === "string"
      ) {
        const actual = readText(output.absPath);
        if (
          typeof actual !== "string" ||
          actual.trim() !== liveToolEvidence.expectedArtifactContent.trim()
        ) {
          verify = { ok: false, error: "artifact_does_not_match_tool_result" };
        }
      }
    } catch (error) {
      verify = { ok: false, error: "grader_failed", detail: errorText(error) };
    }
  }

  if (scenario.followUp) {
    let priorEvents = new Set();
    try {
      const prior = await client.request("task.events", { taskId, limit: 500 }, deadlineAt);
      priorEvents = new Set(
        (prior && Array.isArray(prior.events) ? prior.events : []).map((event) => event.id),
      );
    } catch (error) {
      return {
        name: scenario.name,
        ok: false,
        phase: "followup_baseline",
        taskId,
        reason: errorText(error),
      };
    }
    try {
      await client.request("task.sendMessage", { taskId, message: scenario.followUp }, deadlineAt);
    } catch (error) {
      return {
        name: scenario.name,
        ok: false,
        phase: "followup_send",
        taskId,
        reason: errorText(error),
      };
    }
    const followup = await waitForFollowUp(
      client,
      taskId,
      priorEvents,
      deadlineAt,
      options.pollMs,
    ).catch((error) => ({
      ok: false,
      reason: error && error.deadlineExceeded ? "timeout" : errorText(error),
    }));
    if (!followup.ok) {
      const cleanup = await cancelAndObserve(client, taskId);
      return {
        name: scenario.name,
        ok: false,
        phase: "followup_wait",
        taskId,
        reason: followup.reason,
        cleanup,
        unresolvedOwnedWork: cleanup.unresolvedOwnedTask
          ? {
              ...cleanup.unresolvedOwnedTask,
              profileDir: options.profileDir,
              runtimePid: options.runtimePid || null,
            }
          : null,
      };
    }
    if (output.absPath) {
      try {
        verify = ["pdf", "pptx", "xlsx"].includes(scenario.artifactKind)
          ? await runBoundedGrader(
              scenario.artifactKind,
              output.absPath,
              options.runId,
              deadlineAt,
              {
                mode: options.mode,
                pdfMemoryLimitBytes: options.pdfMemoryLimitBytes,
              },
            )
          : await scenario.verify(output.absPath);
      } catch (error) {
        verify = { ok: false, error: "grader_failed_after_followup", detail: errorText(error) };
      }
    }
  }

  return {
    name: scenario.name,
    ok: verify && verify.ok === true,
    taskId,
    status: wait.task.status,
    output: scenario.outRel,
    artifactKind: scenario.artifactKind || "text",
    verify,
    ...(liveToolEvidence
      ? {
          toolEvidence: {
            tool: liveToolEvidence.tool,
            toolUseId: liveToolEvidence.toolUseId,
            matchedSuccessfulResult: true,
            ...(typeof liveToolEvidence.expectedArtifactContent === "string"
              ? { artifactMatchesToolResult: true }
              : {}),
          },
        }
      : {}),
    ...(verify && verify.unresolvedOwnedProcess
      ? {
          unresolvedOwnedWork: {
            stage: "artifact_grader",
            ...verify.unresolvedOwnedProcess,
            profileDir: options.profileDir,
          },
        }
      : {}),
    durationMs: Date.now() - startedAt,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function allowedProviderEnvironment() {
  const provider = String(process.env.COWORK_QA_LLM_PROVIDER || "")
    .trim()
    .toLowerCase();
  if (!provider)
    throw new Error(
      "Live mode requires COWORK_QA_LLM_PROVIDER in the disposable run configuration",
    );
  const env = {};
  const copy = (source, target = source) => {
    const value = process.env[source];
    if (typeof value === "string" && value.trim()) env[target] = value;
  };
  const providerKeys = {
    openai: ["COWORK_QA_OPENAI_API_KEY"],
    anthropic: ["COWORK_QA_ANTHROPIC_API_KEY"],
    openrouter: ["COWORK_QA_OPENROUTER_API_KEY"],
    gemini: ["COWORK_QA_GEMINI_API_KEY"],
    ollama: [],
    lmstudio: [],
  };
  if (!(provider in providerKeys))
    throw new Error("Unsupported COWORK_QA_LLM_PROVIDER: " + provider);
  const providerKeyEnv = providerKeys[provider];
  if (providerKeyEnv.length > 0 && !providerKeyEnv.some((name) => process.env[name])) {
    throw new Error(
      "Live mode has no " + provider + " provider credential; set its COWORK_QA_* key",
    );
  }
  if (provider === "ollama" || provider === "lmstudio") {
    const baseUrlName =
      provider === "ollama" ? "COWORK_QA_OLLAMA_BASE_URL" : "COWORK_QA_LMSTUDIO_BASE_URL";
    if (!process.env[baseUrlName]) throw new Error("Live mode requires " + baseUrlName);
    copy(baseUrlName, provider === "ollama" ? "OLLAMA_BASE_URL" : "LMSTUDIO_BASE_URL");
  }
  for (const key of providerKeyEnv) {
    const target = {
      COWORK_QA_OPENAI_API_KEY: "OPENAI_API_KEY",
      COWORK_QA_ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      COWORK_QA_OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
      COWORK_QA_GEMINI_API_KEY: "GEMINI_API_KEY",
    }[key];
    if (target) copy(key, target);
  }
  const model = process.env.COWORK_QA_MODEL;
  if (model) {
    if (provider === "openai") env.OPENAI_MODEL = model;
    else if (provider === "anthropic") env.ANTHROPIC_MODEL = model;
    else if (provider === "openrouter") env.OPENROUTER_MODEL = model;
    else if (provider === "gemini") env.GEMINI_MODEL = model;
    else if (provider === "ollama") env.OLLAMA_MODEL = model;
  }
  const searchProvider = [
    "COWORK_QA_TAVILY_API_KEY",
    "COWORK_QA_BRAVE_API_KEY",
    "COWORK_QA_SERPAPI_API_KEY",
  ].find((name) => process.env[name]);
  if (searchProvider) {
    const target = {
      COWORK_QA_TAVILY_API_KEY: "TAVILY_API_KEY",
      COWORK_QA_BRAVE_API_KEY: "BRAVE_API_KEY",
      COWORK_QA_SERPAPI_API_KEY: "SERPAPI_API_KEY",
    }[searchProvider];
    copy(searchProvider, target);
  }
  env.COWORK_LLM_PROVIDER = provider;
  return env;
}

function minimalDaemonEnvironment(providerEnv, profileDir, port) {
  const allowedBase = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "SystemRoot",
    "WINDIR",
  ];
  const childEnv = {};
  for (const name of allowedBase) if (process.env[name]) childEnv[name] = process.env[name];
  Object.assign(childEnv, providerEnv);
  childEnv.COWORK_USER_DATA_DIR = profileDir;
  childEnv.COWORK_HEADLESS = "1";
  childEnv.COWORK_IMPORT_ENV_SETTINGS = "1";
  childEnv.COWORK_CONTROL_PLANE_HOST = "127.0.0.1";
  childEnv.COWORK_CONTROL_PLANE_PORT = String(port);
  return childEnv;
}

function spawnOwnedDaemon(profileDir, port, providerEnv, startupTimeoutMs) {
  if (!fs.existsSync(DAEMON_MAIN)) {
    throw new Error(
      "Built Node daemon is missing at " + DAEMON_MAIN + "; run npm run build:daemon before --live",
    );
  }
  try {
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
  } catch (error) {
    throw new Error(
      "Node better-sqlite3 is not ready; run the approved Node native setup before --live (" +
        errorText(error) +
        ")",
    );
  }
  const args = [DAEMON_MAIN, "--headless", "--enable-control-plane", "--print-control-plane-token"];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: minimalDaemonEnvironment(providerEnv, profileDir, port),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const lines = [];
  let bufferedStdout = "";
  let controlPlaneUrl = "";
  let token = "";
  let reportedUserData = "";
  let settled = false;
  let startupTimer;
  let resolveReady;
  let rejectReady;
  const configuredSecretValues = Object.values(providerEnv).filter(
    (value) => typeof value === "string" && value.length >= 4,
  );
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const sanitizedLine = (line) =>
    configuredSecretValues.reduce(
      (safeLine, secret) => safeLine.split(secret).join("[redacted]"),
      line
        .replace(/Control Plane token:\s*\S+/i, "Control Plane token: [redacted]")
        .replace(/\b(sk-[A-Za-z0-9_-]{12,}|sk-or-v1-[A-Za-z0-9_-]{12,})\b/g, "[redacted]"),
    );
  const processLine = (line) => {
    const userDataMatch = line.match(/\[Daemon\] userData:\s*(.+)$/);
    if (userDataMatch) reportedUserData = path.resolve(userDataMatch[1].trim());
    const addressMatch = line.match(
      /\[Daemon\] Control Plane listening:\s*(ws:\/\/127\.0\.0\.1:\d+)/,
    );
    if (addressMatch) controlPlaneUrl = addressMatch[1];
    const tokenMatch = line.match(/\[Daemon\] Control Plane token:\s*(\S+)/);
    if (tokenMatch) token = tokenMatch[1];
    lines.push(sanitizedLine(line));
    if (lines.length > 80) lines.shift();
    if (!settled && controlPlaneUrl && token && reportedUserData === path.resolve(profileDir)) {
      settled = true;
      clearTimeout(startupTimer);
      resolveReady({ child, url: controlPlaneUrl, token, logTail: lines.slice(-20) });
    }
  };
  child.stdout.on("data", (chunk) => {
    bufferedStdout += String(chunk);
    while (bufferedStdout.includes("\n")) {
      const index = bufferedStdout.indexOf("\n");
      processLine(bufferedStdout.slice(0, index).trim());
      bufferedStdout = bufferedStdout.slice(index + 1);
    }
  });
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      lines.push(sanitizedLine(line));
      if (lines.length > 80) lines.shift();
    }
  });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(startupTimer);
    rejectReady(error);
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(startupTimer);
    rejectReady(
      new Error(
        "Owned daemon exited before Control Plane startup (code=" +
          code +
          ", signal=" +
          signal +
          "): " +
          lines.slice(-8).join(" | "),
      ),
    );
  });
  startupTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectReady(
      new Error("Owned daemon startup deadline exceeded: " + lines.slice(-8).join(" | ")),
    );
  }, startupTimeoutMs);
  return {
    child,
    ready,
    get logTail() {
      return lines.slice(-20);
    },
  };
}

function signalOwnedProcessTree(child, signal, options = {}) {
  if (!child || !child.pid) return false;
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    try {
      const run = options.spawnSyncImpl || spawnSync;
      const result = run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      return Boolean(result && !result.error && result.status === 0);
    } catch {
      return false;
    }
  }
  const kill = options.killImpl || process.kill;
  try {
    kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

function processGroupExists(processGroupId, options = {}) {
  const platform = options.platform || process.platform;
  if (!processGroupId || platform === "win32") return false;
  const kill = options.killImpl || process.kill;
  try {
    kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitProcessTreeExit(child, timeoutMs, options = {}) {
  if (!child || !child.pid) return true;
  const platform = options.platform || process.platform;
  const deadlineAt = Date.now() + timeoutMs;
  const isLeaderExited = () => child.exitCode !== null || child.signalCode !== null;
  const isTreeGone = () => {
    if (platform === "win32") {
      return options.knownLeaf === true || options.windowsTreeKillAcknowledged === true;
    }
    const exists = options.processGroupExistsImpl || processGroupExists;
    return !exists(child.pid, options);
  };
  while (Date.now() < deadlineAt) {
    if (isLeaderExited() && isTreeGone()) return true;
    await sleep(Math.min(40, Math.max(1, deadlineAt - Date.now())));
  }
  return isLeaderExited() && isTreeGone();
}

async function stopOwnedChildren(children, timeoutMs = CLEANUP_TIMEOUT_MS, options = {}) {
  const platform = options.platform || process.platform;
  const unresolved = [];
  const signals = new Map();
  const alreadyStoppedChildren = new Set();
  for (const child of children) {
    const alreadyStopped = await waitProcessTreeExit(child, 1, {
      ...options,
      ...(platform === "win32" && child.qaKnownLeafProcess ? { knownLeaf: true } : {}),
    });
    if (alreadyStopped) {
      activeOwnedChildren.delete(child);
      alreadyStoppedChildren.add(child);
      continue;
    }
    const signaled = signalOwnedProcessTree(child, "SIGTERM", options);
    signals.set(child, signaled);
  }
  let forcedTermination = platform === "win32" && signals.size > 0;
  for (const child of children) {
    if (alreadyStoppedChildren.has(child)) continue;
    const signalAck = signals.get(child);
    let stopped;
    if (platform === "win32") {
      stopped = await waitProcessTreeExit(child, timeoutMs, {
        ...options,
        windowsTreeKillAcknowledged: signalAck === true,
      });
    } else {
      stopped = await waitProcessTreeExit(child, Math.min(timeoutMs, 750), options);
      if (!stopped) {
        const forced = signalOwnedProcessTree(child, "SIGKILL", options);
        forcedTermination ||= forced;
        stopped = await waitProcessTreeExit(child, 1000, options);
      }
    }
    if (stopped) activeOwnedChildren.delete(child);
    else
      unresolved.push({
        pid: child.pid,
        processGroupId: platform === "win32" ? null : child.pid,
        ...(platform === "win32"
          ? { termination: "forced; taskkill tree confirmation unavailable" }
          : {}),
      });
  }
  return {
    stopped: unresolved.length === 0,
    unresolved,
    termination: forcedTermination ? "forced" : "graceful_or_not_needed",
  };
}

async function stopOwnedDaemon(child, timeoutMs = 5000, profileDir = null, options = {}) {
  if (!child || !child.pid)
    return { stopped: true, pid: child && child.pid, termination: "not_needed" };
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    const acknowledged = signalOwnedProcessTree(child, "SIGKILL", options);
    const stopped = await waitProcessTreeExit(child, timeoutMs, {
      ...options,
      windowsTreeKillAcknowledged: acknowledged,
    });
    return {
      stopped,
      pid: child.pid,
      signal: "taskkill /T /F",
      termination: "forced",
      processTreeSignaled: acknowledged,
      ...(!stopped
        ? {
            unresolvedOwnedProcess: {
              pid: child.pid,
              processGroupId: null,
              profileDir,
              reason: acknowledged
                ? "taskkill acknowledged but daemon leader exit was not observed"
                : "taskkill /T /F did not confirm termination; descendants are unknown",
            },
          }
        : {}),
    };
  }
  const termSignaled = signalOwnedProcessTree(child, "SIGTERM", options);
  if (await waitProcessTreeExit(child, timeoutMs, options)) {
    return {
      stopped: true,
      pid: child.pid,
      signal: "SIGTERM",
      termination: "graceful",
      processTreeSignaled: termSignaled,
    };
  }
  const killSignaled = signalOwnedProcessTree(child, "SIGKILL", options);
  const stopped = await waitProcessTreeExit(child, 1500, options);
  return {
    stopped,
    pid: child.pid,
    signal: "SIGKILL",
    termination: "forced",
    processTreeSignaled: killSignaled,
    ...(stopped
      ? {}
      : {
          unresolvedOwnedProcess: {
            pid: child.pid,
            processGroupId: child.pid,
            profileDir,
          },
        }),
  };
}

async function checkLivePrerequisites(client, deadlineAt) {
  const config = await client.request("config.get", {}, deadlineAt);
  const llm = config && config.llm;
  const providers = llm && Array.isArray(llm.providers) ? llm.providers : [];
  const currentProvider = llm && llm.currentProvider;
  const selected = providers.find((provider) => provider.type === currentProvider);
  const missing = [];
  if (!selected || selected.configured !== true)
    missing.push("selected LLM provider configuration");
  if (!config || !config.search || config.search.isConfigured !== true)
    missing.push("web-search provider configuration");
  if (missing.length) {
    throw new Error(
      "Live run prerequisites are missing: " +
        missing.join(", ") +
        ". The owned profile was not sent any tasks.",
    );
  }
  return { provider: currentProvider, search: "configured" };
}

async function runBattery(client, options) {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const totalDeadlineAt = options.totalDeadlineAt || Date.now() + options.totalTimeoutMs;
  const scenarios = createScenarios(runId);
  const results = [];
  for (const scenario of scenarios) {
    if (options.shouldStop && options.shouldStop()) break;
    if (Date.now() >= totalDeadlineAt) {
      results.push({
        name: scenario.name,
        ok: false,
        phase: "deadline",
        reason: "battery_deadline_exceeded",
      });
      break;
    }
    console.log("[battery] task: " + scenario.name);
    const result = await runScenario(client, scenario, {
      mode: options.mode,
      pdfMemoryLimitBytes: options.pdfMemoryLimitBytes,
      workspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      profileDir: options.profileDir,
      runtimePid: options.runtimePid,
      runId,
      timeoutMs: options.timeoutMs,
      totalDeadlineAt,
      pollMs: options.pollMs,
      approvalMode: options.approvalMode,
      approveTypes: options.approveTypes,
      approvalScopes: options.approvalScopes,
    });
    results.push(result);
    console.log("[battery] " + (result.ok ? "PASS " : "FAIL ") + scenario.name);
    if (result.unresolvedOwnedWork) {
      console.error(
        "[battery] unresolved owned work: " + JSON.stringify(result.unresolvedOwnedWork),
      );
      break;
    }
  }
  return { runId, results };
}

async function runApprovalFixtureChecks(client, workspace, options) {
  const results = [];
  const blockedScenario = {
    name: "qa-approval-default-stop",
    message: "Fixture-only approval stop check",
    outRel: "approval-default-stop.txt",
    fixture: {
      kind: "text",
      content: "safe",
      approvalType: "fixture_safe_artifact_write",
      approvalDetails: { path: "approval-default-stop.txt", operation: "write" },
    },
  };
  const blocked = await runScenario(client, blockedScenario, {
    ...options,
    mode: "fixtures",
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    runId: options.runId,
    timeoutMs: 4000,
    totalDeadlineAt: Math.min(options.totalDeadlineAt || Infinity, Date.now() + 6000),
    approvalMode: "stop",
    approveTypes: new Set(),
  });
  const stopped =
    blocked.reason === "pending_approval" &&
    blocked.cleanup &&
    blocked.cleanup.status === "cancelled";
  results.push({
    name: "default approval mode stops and cancels pending work",
    ok: stopped,
    approvalResponded: false,
    result: blocked,
  });

  const allowedScenario = {
    name: "qa-approval-allow-listed",
    message: "Fixture-only exact approval allow-list check",
    outRel: "approval-allow-listed.txt",
    fixture: {
      kind: "text",
      content: "safe",
      approvalType: "fixture_safe_artifact_write",
      approvalDetails: { path: "approval-allow-listed.txt", operation: "write" },
    },
    verify: (abs) => verifyExactText(abs, "safe"),
  };
  const allowed = await runScenario(client, allowedScenario, {
    ...options,
    mode: "fixtures",
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    runId: options.runId,
    timeoutMs: 4000,
    totalDeadlineAt: Math.min(options.totalDeadlineAt || Infinity, Date.now() + 6000),
    approvalMode: "allow-list",
    approveTypes: new Set(["fixture_safe_artifact_write"]),
    approvalScopes: new Set(["workspace"]),
  });
  const responses = options.fixtureService.getApprovalResponses();
  const exactApprovalOnly =
    responses.length === 1 &&
    responses[0].type === "fixture_safe_artifact_write" &&
    responses[0].approved === true;
  results.push({
    name: "only the exact allow-listed approval type is accepted",
    ok: allowed.ok && exactApprovalOnly,
    approvalResponded: exactApprovalOnly,
    result: allowed,
  });

  const outsideScopeScenario = {
    name: "qa-approval-outside-scope",
    message: "Fixture-only out-of-scope approval check",
    outRel: "approval-outside-scope.txt",
    fixture: {
      kind: "text",
      content: "must not run",
      approvalType: "fixture_safe_artifact_write",
      approvalDetails: { path: "../outside-scope.txt", operation: "write" },
    },
  };
  const outsideScope = await runScenario(client, outsideScopeScenario, {
    ...options,
    mode: "fixtures",
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    runId: options.runId,
    timeoutMs: 4000,
    totalDeadlineAt: Math.min(options.totalDeadlineAt || Infinity, Date.now() + 6000),
    approvalMode: "allow-list",
    approveTypes: new Set(["fixture_safe_artifact_write"]),
    approvalScopes: new Set(["workspace"]),
  });
  const outsideStopped =
    outsideScope.reason === "pending_approval" &&
    outsideScope.cleanup &&
    outsideScope.cleanup.status === "cancelled" &&
    options.fixtureService.getApprovalResponses().length === 1;
  results.push({
    name: "allow-list stops matching types outside the explicit workspace scope",
    ok: outsideStopped,
    result: outsideScope,
  });

  return results;
}

async function runTimeoutFixtureCheck(client, workspace, options) {
  const scenario = {
    name: "qa-battery-owned-timeout-probe",
    message: "Fixture-only worker that must be cancelled at the deadline",
    outRel: "timeout-probe.txt",
    fixture: { kind: "hang" },
    verify: (abs) => verifyExactText(abs, "never-written"),
  };
  const result = await runScenario(client, scenario, {
    ...options,
    mode: "fixtures",
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    runId: options.runId,
    timeoutMs: 350,
    totalDeadlineAt: Math.min(options.totalDeadlineAt || Infinity, Date.now() + 2500),
    pollMs: 25,
    approvalMode: "stop",
    approveTypes: new Set(),
  });
  const task = result.taskId ? options.fixtureService.getTask(result.taskId) : null;
  const workerExited = !!(task && task.workerExit && task.workerExit.signal);
  const clean =
    result.reason === "timeout" &&
    result.cleanup &&
    result.cleanup.status === "cancelled" &&
    result.cleanup.resolved &&
    workerExited &&
    options.fixtureService.getOwnedProcesses().length === 0;
  return {
    name: "bounded deadline cancels the owned worker and confirms exit",
    ok: clean,
    expectedTimeout: true,
    workerExited,
    remainingOwnedProcesses: options.fixtureService.getOwnedProcesses(),
    result,
  };
}

async function runFixtureMode(options) {
  const totalDeadlineAt = Date.now() + options.totalTimeoutMs;
  checkModulePrerequisites(true);
  const profileDir = createProfileDir("", "cowork-battery-fixtures-");
  const workspacePath = path.join(profileDir, "workspace");
  try {
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(path.join(workspacePath, ".tmp", "qa-workspace"), { recursive: true });
  } catch (error) {
    throw withProfileCleanupError(error, profileDir, { cleanupAllowed: true });
  }
  let fixtureService;
  let client;
  let receivedSignal = "";
  let interruptionCleanup;
  let onFixtureSigint;
  let onFixtureSigterm;
  try {
    fixtureService = startFixtureControlPlane({ profileDir });
    const onInterrupt = (signal) => {
      if (receivedSignal) return;
      receivedSignal = signal;
      if (client) client.close();
      interruptionCleanup = Promise.all([
        fixtureService.close(),
        stopOwnedChildren([...activeOwnedChildren]),
      ]).then(([, graderCleanup]) => graderCleanup);
    };
    onFixtureSigint = () => onInterrupt("SIGINT");
    onFixtureSigterm = () => onInterrupt("SIGTERM");
    process.once("SIGINT", onFixtureSigint);
    process.once("SIGTERM", onFixtureSigterm);
    await fixtureService.listening;
  } catch (error) {
    if (fixtureService) await fixtureService.close().catch(() => {});
    if (onFixtureSigint) process.off("SIGINT", onFixtureSigint);
    if (onFixtureSigterm) process.off("SIGTERM", onFixtureSigterm);
    const serviceStopped = !fixtureService || fixtureService.getOwnedProcesses().length === 0;
    throw withProfileCleanupError(error, profileDir, { cleanupAllowed: serviceStopped });
  }
  client = new BoundedControlPlaneClient({ url: fixtureService.url, token: fixtureService.token });
  let workspace;
  let runResult;
  let controlChecks = [];
  let ownedProcessCleanup;
  let fatalError;
  try {
    await client.connect(Math.min(totalDeadlineAt, Date.now() + 5000));
    const workspaceResult = await client.request(
      "workspace.create",
      {
        name: "CoWork Disposable Eval",
        path: workspacePath,
      },
      Math.min(totalDeadlineAt, Date.now() + 5000),
    );
    workspace = workspaceResult.workspace;
    if (!workspace || workspace.path !== workspacePath)
      throw new Error("Fixture Control Plane did not bind the disposable workspace");
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    runResult = await runBattery(client, {
      ...options,
      mode: "fixtures",
      workspaceId: workspace.id,
      workspacePath,
      profileDir,
      runtimePid: null,
      totalDeadlineAt,
      shouldStop: () => Boolean(receivedSignal),
    });
    if (!receivedSignal) {
      controlChecks = await runApprovalFixtureChecks(client, workspace, {
        ...options,
        fixtureService,
        runId,
        totalDeadlineAt,
      });
      controlChecks.push(
        await runTimeoutFixtureCheck(client, workspace, {
          ...options,
          fixtureService,
          runId,
          totalDeadlineAt,
        }),
      );
    }
    if (receivedSignal) fatalError = "Interrupted by " + receivedSignal;
  } catch (error) {
    fatalError = errorText(error);
  } finally {
    process.off("SIGINT", onFixtureSigint);
    process.off("SIGTERM", onFixtureSigterm);
    client.close();
    if (!ownedProcessCleanup) {
      ownedProcessCleanup = await (
        interruptionCleanup ||
        Promise.all([fixtureService.close(), stopOwnedChildren([...activeOwnedChildren])]).then(
          ([, graderCleanup]) => graderCleanup,
        )
      )
        .then((graderCleanup) => ({
          stopped: fixtureService.getOwnedProcesses().length === 0 && graderCleanup.stopped,
          remaining: [...fixtureService.getOwnedProcesses(), ...graderCleanup.unresolved],
          graderCleanup,
        }))
        .catch((error) => ({
          stopped: false,
          error: errorText(error),
          remaining: fixtureService.getOwnedProcesses(),
        }));
    }
  }

  const allResults = (runResult && runResult.results) || [];
  const scenarioFailures = allResults.filter((result) => !result.ok);
  const controlFailures = controlChecks.filter((result) => !result.ok);
  const profileCleanup = disposeProfileDir(profileDir, {
    keepProfile: options.keepProfile,
    cleanupAllowed: ownedProcessCleanup.stopped,
  });
  const summary = {
    mode: "fixtures",
    scope:
      "local synthetic orchestration and artifact grader validation; no agent capability or provider evaluation",
    profile: {
      disposable: true,
      isolation: "fresh temporary user-data profile; OS sandbox behavior depends on the runtime",
      path: profileCleanup.path,
      disposition: profileCleanup.disposition,
      ...(profileCleanup.error ? { cleanupError: profileCleanup.error } : {}),
    },
    workspace: {
      path: profileCleanup.path ? workspacePath : null,
      createdByControlPlane: !!workspace,
    },
    deadlines: {
      perTaskMs: options.timeoutMs,
      totalMs: options.totalTimeoutMs,
      httpRequestsBoundedByRemainingDeadline: true,
      cancellationGraceMs: CLEANUP_TIMEOUT_MS,
    },
    approvals: {
      mode: options.approvalMode,
      allowedTypes: [...options.approveTypes],
      resourceScopes: [...options.approvalScopes],
      blanketApproval: false,
    },
    artifactGraders: {
      pdf: "PDF.js text extraction and one-page structure",
      pptx: "bounded OOXML ZIP preflight, namespace-aware XML parsing, resolved slide relationships, required text, and bullet paragraphs",
      xlsx: "bounded ZIP preflight with inflation and CRC checks for every part, then ExcelJS read-back of worksheet, headers, inputs, formula, and cached result=5",
      rendering: detectRenderers(),
    },
    runId: runResult && runResult.runId,
    results: allResults,
    controlChecks,
    ownedProcessCleanup,
    profileCleanup: {
      attempted: profileCleanup.attempted,
      failed: profileCleanup.failed,
    },
    ...(receivedSignal ? { interruptedBy: receivedSignal } : {}),
    status:
      fatalError ||
      scenarioFailures.length ||
      controlFailures.length ||
      !ownedProcessCleanup.stopped ||
      profileCleanup.failed
        ? "failed"
        : "completed",
    ...(fatalError ? { error: fatalError } : {}),
  };
  return summary;
}

async function runLiveMode(options) {
  const totalDeadlineAt = Date.now() + options.totalTimeoutMs;
  checkModulePrerequisites(false);
  const providerEnv = allowedProviderEnvironment();
  const pdfMemoryBound = requireLivePdfMemoryBound(detectCgroupV2MemoryLimit());
  const profileDir = createProfileDir(options.profileDir, "cowork-battery-live-");
  const workspacePath = path.join(profileDir, "workspace");
  let port;
  let owned;
  try {
    port = await allocatePort();
    const startupRemaining = Math.min(60_000, options.timeoutMs, totalDeadlineAt - Date.now());
    if (startupRemaining <= 0)
      throw new Error("Total battery deadline expired before owned daemon startup");
    owned = spawnOwnedDaemon(profileDir, port, providerEnv, startupRemaining);
  } catch (error) {
    throw withProfileCleanupError(error, profileDir, { cleanupAllowed: !owned });
  }
  let client;
  let workspace;
  let battery;
  let prerequisites;
  let fatalError;
  let shutdown;
  let receivedSignal = "";
  let interruptionCleanup;
  const onInterrupt = (signal) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    if (client) client.close();
    interruptionCleanup = (async () => {
      const graderCleanup = await stopOwnedChildren([...activeOwnedChildren]);
      const daemonCleanup = await stopOwnedDaemon(owned.child, CLEANUP_TIMEOUT_MS, profileDir);
      return {
        ...daemonCleanup,
        stopped: daemonCleanup.stopped && graderCleanup.stopped,
        graderCleanup,
      };
    })();
  };
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const ready = await owned.ready;
    client = new BoundedControlPlaneClient({ url: ready.url, token: ready.token });
    await client.connect(
      Math.min(totalDeadlineAt, Date.now() + Math.min(15_000, options.timeoutMs)),
    );
    const health = await client.request(
      "health",
      {},
      Math.min(totalDeadlineAt, Date.now() + Math.min(10_000, options.timeoutMs)),
    );
    if (!health || health.status !== "ok")
      throw new Error("Owned Control Plane health check failed");
    prerequisites = await checkLivePrerequisites(
      client,
      Math.min(totalDeadlineAt, Date.now() + Math.min(15_000, options.timeoutMs)),
    );
    const workspaceResponse = await client.request(
      "workspace.create",
      {
        name: "CoWork Disposable Eval",
        path: workspacePath,
      },
      Math.min(totalDeadlineAt, Date.now() + Math.min(15_000, options.timeoutMs)),
    );
    workspace = workspaceResponse && workspaceResponse.workspace;
    if (!workspace || path.resolve(workspace.path) !== path.resolve(workspacePath)) {
      throw new Error("Owned runtime did not return the requested disposable workspace");
    }
    fs.mkdirSync(path.join(workspacePath, ".tmp", "qa-workspace"), { recursive: true });
    battery = await runBattery(client, {
      ...options,
      mode: "live",
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      profileDir,
      runtimePid: owned.child.pid,
      pdfMemoryLimitBytes: pdfMemoryBound.memoryLimitBytes,
      totalDeadlineAt,
      shouldStop: () => Boolean(receivedSignal),
    });
    if (receivedSignal) fatalError = "Interrupted by " + receivedSignal;
  } catch (error) {
    fatalError = errorText(error);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (client) client.close();
    if (interruptionCleanup) {
      shutdown = await interruptionCleanup;
    } else {
      const graderCleanup = await stopOwnedChildren([...activeOwnedChildren]);
      const daemonCleanup = await stopOwnedDaemon(owned.child, CLEANUP_TIMEOUT_MS, profileDir);
      shutdown = {
        ...daemonCleanup,
        stopped: daemonCleanup.stopped && graderCleanup.stopped,
        graderCleanup,
      };
    }
  }

  const results = (battery && battery.results) || [];
  const scenarioFailures = results.filter((result) => !result.ok);
  const unresolved = results.filter((result) => result.unresolvedOwnedWork);
  const profileCleanup = disposeProfileDir(profileDir, {
    keepProfile: options.keepProfile,
    cleanupAllowed: shutdown.stopped && unresolved.length === 0,
  });
  const summary = {
    mode: "live",
    scope:
      "owned Node daemon with a fresh disposable user-data profile/workspace and explicit provider/network opt-in",
    profile: {
      disposable: true,
      isolation: "fresh temporary user-data profile; OS sandbox behavior depends on the runtime",
      path: profileCleanup.path,
      disposition: profileCleanup.disposition,
      ...(profileCleanup.error ? { cleanupError: profileCleanup.error } : {}),
    },
    profileCleanup: {
      attempted: profileCleanup.attempted,
      failed: profileCleanup.failed,
    },
    workspace: {
      path: profileCleanup.path ? workspacePath : null,
      createdByControlPlane: !!workspace,
    },
    runtime: {
      pid: owned.child.pid,
      userDataDirObservedFromOwnedProcess: true,
      provider: prerequisites && prerequisites.provider,
      search: prerequisites && prerequisites.search,
      pdfMemoryBound: {
        source: pdfMemoryBound.source,
        limitBytes: pdfMemoryBound.memoryLimitBytes,
      },
    },
    deadlines: {
      perTaskMs: options.timeoutMs,
      totalMs: options.totalTimeoutMs,
      controlPlaneRequestsBoundedByRemainingDeadline: true,
      cancellationGraceMs: CLEANUP_TIMEOUT_MS,
    },
    approvals: {
      mode: options.approvalMode,
      allowedTypes: [...options.approveTypes],
      resourceScopes: [...options.approvalScopes],
      blanketApproval: false,
    },
    artifactGraders: {
      pdf: "PDF.js text extraction and one-page structure",
      pptx: "bounded OOXML ZIP preflight, namespace-aware XML parsing, resolved slide relationships, required text, and bullet paragraphs",
      xlsx: "bounded ZIP preflight with inflation and CRC checks for every part, then ExcelJS read-back of worksheet, headers, inputs, formula, and cached result=5",
      rendering: detectRenderers(),
    },
    runId: battery && battery.runId,
    results,
    daemonCleanup: { ...shutdown, unresolvedOwnedWork: unresolved.length > 0 ? unresolved : null },
    ...(receivedSignal ? { interruptedBy: receivedSignal } : {}),
    status:
      fatalError ||
      scenarioFailures.length ||
      unresolved.length ||
      !shutdown.stopped ||
      profileCleanup.failed
        ? "failed"
        : "completed",
    ...(fatalError || profileCleanup.failed
      ? {
          error: [
            fatalError,
            profileCleanup.failed ? "Profile cleanup failed: " + profileCleanup.error : "",
          ]
            .filter(Boolean)
            .join("; "),
        }
      : {}),
  };
  return summary;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error("[battery] " + errorText(error));
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    usage();
    return;
  }
  let summary;
  try {
    summary = options.mode === "live" ? await runLiveMode(options) : await runFixtureMode(options);
  } catch (error) {
    summary = {
      mode: options.mode,
      status: "failed",
      error: errorText(error),
      ...(error && error.profileCleanup
        ? {
            profile: {
              disposable: true,
              path: error.profileCleanup.path,
              disposition: error.profileCleanup.disposition,
              ...(error.profileCleanup.error ? { cleanupError: error.profileCleanup.error } : {}),
            },
            profileCleanup: {
              attempted: error.profileCleanup.attempted,
              failed: error.profileCleanup.failed,
            },
          }
        : {}),
      approvals: {
        mode: options.approvalMode,
        allowedTypes: [...options.approveTypes],
        resourceScopes: [...options.approvalScopes],
        blanketApproval: false,
      },
    };
  }
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("[battery] mode: " + summary.mode);
    console.log("[battery] status: " + summary.status);
    console.log("[battery] scope: " + summary.scope);
    for (const result of summary.results || []) {
      console.log("- " + (result.ok ? "PASS " : "FAIL ") + result.name);
      if (!result.ok)
        console.log(
          "  reason: " + (result.reason || result.error || result.phase || "verification failed"),
        );
      if (result.verify && result.verify.error) console.log("  grader: " + result.verify.error);
      if (result.unresolvedOwnedWork)
        console.log("  unresolved: " + JSON.stringify(result.unresolvedOwnedWork));
    }
    for (const check of summary.controlChecks || []) {
      console.log("- " + (check.ok ? "PASS " : "FAIL ") + check.name);
    }
    if (summary.error) console.error("[battery] error: " + summary.error);
    console.log(
      "[battery] approval mode: " +
        summary.approvals.mode +
        "; allow-listed types: " +
        (summary.approvals.allowedTypes.join(", ") || "none"),
    );
    console.log(
      "[battery] renderers: " +
        JSON.stringify(summary.artifactGraders && summary.artifactGraders.rendering),
    );
  }
  if (summary.status !== "completed") process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  BoundedControlPlaneClient,
  createScenarios,
  detectCgroupV2MemoryLimit,
  disposeProfileDir,
  isApprovalInScope,
  isApprovalInWorkspace,
  main,
  minimalDaemonEnvironment,
  parseArgs,
  runBoundedGrader,
  runScenario,
  signalOwnedProcessTree,
  stopOwnedChildren,
  stopOwnedDaemon,
  verifyToolEvidenceFromEvents,
  waitForFollowUp,
  waitForTerminalStatus,
  withProfileCleanupError,
  waitProcessTreeExit,
};
