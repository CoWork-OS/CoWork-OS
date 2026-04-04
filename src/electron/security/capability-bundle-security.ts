import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type {
  CapabilityBundleKind,
  CapabilitySecurityFinding,
  CapabilitySecurityImportSource,
  CapabilitySecurityReport,
  CapabilitySecuritySeverity,
  CustomSkill,
  ImportSecurityReportRequest,
  InstallSecurityOutcome,
  QuarantinedImportRecord,
  RetryQuarantinedImportResult,
} from "../../shared/types";
import type { DeclarativeConnector, PluginManifest } from "../extensions/types";
import { createLogger } from "../utils/logger";
import { getUserDataDir } from "../utils/user-data-dir";

const logger = createLogger("CapabilityBundleSecurity");

const PACK_REPORT_FILENAME = ".cowork-security.json";
const SKILL_REPORT_SUFFIX = ".security.json";
const QUARANTINE_PAYLOAD_DIR = "payload";
const QUARANTINE_METADATA_FILENAME = "metadata.json";
const QUARANTINE_REPORT_FILENAME = "report.json";
const MAX_SCANNED_FILE_BYTES = 256 * 1024;
const MAX_PACKAGE_LOOKUPS = 8;
const IGNORED_SCAN_ENTRIES = new Set([
  ".git",
  PACK_REPORT_FILENAME,
  QUARANTINE_METADATA_FILENAME,
  QUARANTINE_REPORT_FILENAME,
]);
const EXECUTABLE_EXTENSIONS = new Set([
  ".app",
  ".bin",
  ".com",
  ".dll",
  ".dylib",
  ".exe",
  ".msi",
  ".node",
  ".o",
  ".obj",
  ".out",
  ".so",
]);

type PackageEcosystem = "npm" | "PyPI";

interface PackageCandidate {
  ecosystem: PackageEcosystem;
  name: string;
}

interface QuarantineMetadata {
  version: 1;
  id: string;
  bundleKind: CapabilityBundleKind;
  bundleId: string;
  displayName?: string;
  source: CapabilitySecurityImportSource;
  managed: boolean;
  quarantinedAt: string;
  activeManifestPath?: string;
  activeBundleDir?: string;
  activePackDir?: string;
}

interface SkillScanContext {
  bundleId: string;
  displayName?: string;
  source: CapabilitySecurityImportSource;
  managed: boolean;
  stageDir: string;
}

interface PackScanContext {
  bundleId: string;
  displayName?: string;
  source: CapabilitySecurityImportSource;
  managed: boolean;
  rootDir: string;
  manifest: PluginManifest;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeForHash(value: string): string {
  return value.replace(/\\/g, "/");
}

function isLikelyTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (
    ext === "" ||
    [
      ".cjs",
      ".conf",
      ".css",
      ".html",
      ".ini",
      ".js",
      ".json",
      ".jsx",
      ".mjs",
      ".md",
      ".py",
      ".rb",
      ".sh",
      ".sql",
      ".ts",
      ".tsx",
      ".txt",
      ".yaml",
      ".yml",
      ".zsh",
    ].includes(ext)
  );
}

function pathInside(parentDir: string, candidatePath: string): boolean {
  const parent = path.resolve(parentDir);
  const target = path.resolve(candidatePath);
  return target === parent || target.startsWith(`${parent}${path.sep}`);
}

function uniqueFindings(findings: CapabilitySecurityFinding[]): CapabilitySecurityFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}:${finding.path || ""}:${finding.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function highestSeverity(findings: CapabilitySecurityFinding[]): CapabilitySecuritySeverity | null {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "critical";
  }
  if (findings.some((finding) => finding.severity === "warning")) {
    return "warning";
  }
  if (findings.some((finding) => finding.severity === "info")) {
    return "info";
  }
  return null;
}

function buildSummary(
  verdict: CapabilitySecurityReport["verdict"],
  findings: CapabilitySecurityFinding[],
  intelligenceUnavailable: boolean,
): string {
  const counts = findings.reduce(
    (acc, finding) => {
      acc[finding.severity] += 1;
      return acc;
    },
    { info: 0, warning: 0, critical: 0 },
  );

  if (verdict === "quarantined") {
    return counts.critical > 0
      ? `Quarantined after ${counts.critical} critical security finding${counts.critical === 1 ? "" : "s"}`
      : "Quarantined pending security review";
  }

  if (counts.warning > 0 || counts.info > 0 || intelligenceUnavailable) {
    const parts: string[] = [];
    if (counts.warning > 0) {
      parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
    }
    if (counts.info > 0) {
      parts.push(`${counts.info} notice${counts.info === 1 ? "" : "s"}`);
    }
    if (intelligenceUnavailable) {
      parts.push("package intelligence unavailable");
    }
    return `Installed with ${parts.join(", ")}`;
  }

  return "No security issues detected";
}

function addFinding(
  findings: CapabilitySecurityFinding[],
  finding: CapabilitySecurityFinding,
): void {
  findings.push(finding);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    logger.warn(`Failed to read JSON from ${filePath}`, error);
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function removeIfExists(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function movePath(sourcePath: string, targetPath: string): void {
  ensureDir(path.dirname(targetPath));
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch {
    copyPath(sourcePath, targetPath);
    fs.rmSync(sourcePath, { recursive: true, force: true });
  }
}

function copyPath(sourcePath: string, targetPath: string): void {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    ensureDir(targetPath);
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      if (entry.name === "." || entry.name === "..") continue;
      copyPath(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
    }
    return;
  }

  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function hashEntries(entries: Array<{ relativePath: string; content: Buffer | string }>): string {
  const hash = createHash("sha256");
  const normalized = [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const entry of normalized) {
    hash.update(normalizeForHash(entry.relativePath));
    hash.update("\0");
    hash.update(Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf-8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectDirectoryEntries(
  rootDir: string,
  prefix: string,
  entries: Array<{ relativePath: string; content: Buffer | string }>,
): void {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (IGNORED_SCAN_ENTRIES.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(rootDir, entry.name);
    const relativePath = normalizeForHash(path.join(prefix, entry.name));
    const lst = fs.lstatSync(sourcePath);

    if (lst.isSymbolicLink()) {
      entries.push({
        relativePath,
        content: `symlink:${fs.readlinkSync(sourcePath)}`,
      });
      continue;
    }

    if (lst.isDirectory()) {
      collectDirectoryEntries(sourcePath, relativePath, entries);
      continue;
    }

    if (lst.isFile()) {
      entries.push({
        relativePath,
        content: fs.readFileSync(sourcePath),
      });
    }
  }
}

function collectTextFiles(
  rootDir: string,
  prefix: string,
  findings: CapabilitySecurityFinding[],
  texts: Array<{ path: string; content: string }>,
  skillMode: boolean,
): void {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (IGNORED_SCAN_ENTRIES.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(rootDir, entry.name);
    const relativePath = normalizeForHash(path.join(prefix, entry.name));
    const lst = fs.lstatSync(sourcePath);

    if (lst.isSymbolicLink()) {
      addFinding(findings, {
        code: "symbolic-link",
        severity: "critical",
        path: relativePath,
        message: "Bundle contains a symbolic link that could escape the staged root.",
      });
      continue;
    }

    if (lst.isDirectory()) {
      collectTextFiles(sourcePath, relativePath, findings, texts, skillMode);
      continue;
    }

    if (!lst.isFile()) {
      continue;
    }

    if (skillMode && EXECUTABLE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
      addFinding(findings, {
        code: "unexpected-executable",
        severity: "critical",
        path: relativePath,
        message: "Imported skill bundle contains an unexpected executable artifact.",
      });
    }

    if (lst.size > MAX_SCANNED_FILE_BYTES || !isLikelyTextFile(sourcePath)) {
      continue;
    }

    try {
      const content = fs.readFileSync(sourcePath, "utf-8");
      if (content.includes("\u0000")) {
        addFinding(findings, {
          code: "binary-text-mismatch",
          severity: "critical",
          path: relativePath,
          message: "Bundle contains a binary-like file in a text-scanned location.",
        });
        continue;
      }
      texts.push({ path: relativePath, content });
    } catch (error) {
      addFinding(findings, {
        code: "read-failure",
        severity: "warning",
        path: relativePath,
        message: "A bundle file could not be scanned.",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function collectPackagesFromText(text: string): PackageCandidate[] {
  const packages: PackageCandidate[] = [];
  const seen = new Set<string>();

  const addPackage = (ecosystem: PackageEcosystem, rawName: string) => {
    const name = rawName.trim().replace(/["']/g, "").replace(/@[\w.-]+$/, "");
    if (!name) {
      return;
    }
    const key = `${ecosystem}:${name}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    packages.push({ ecosystem, name });
  };

  for (const match of text.matchAll(/\bnpx\s+(?:--yes\s+|--package\s+\S+\s+|--quiet\s+)*(@?[a-z0-9][\w./-]*)/gi)) {
    addPackage("npm", match[1] || "");
  }

  for (const match of text.matchAll(/\buvx\s+(?:--from\s+)?([A-Za-z0-9_.-]+)/g)) {
    addPackage("PyPI", match[1] || "");
  }

  return packages;
}

function scanTextContent(
  filePath: string,
  text: string,
  findings: CapabilitySecurityFinding[],
  packages: Map<string, PackageCandidate>,
): void {
  const lowerText = text.toLowerCase();

  const registerPackage = (candidate: PackageCandidate) => {
    packages.set(`${candidate.ecosystem}:${candidate.name}`, candidate);
  };

  for (const candidate of collectPackagesFromText(text)) {
    registerPackage(candidate);
  }

  const rules: Array<{
    code: string;
    severity: CapabilitySecuritySeverity;
    message: string;
    test: (value: string, lower: string) => boolean;
  }> = [
    {
      code: "download-and-exec",
      severity: "critical",
      message: "Bundle includes a download-and-execute command chain.",
      test: (value) =>
        /\b(?:curl|wget)\b[\s\S]{0,160}(?:\||&&|;)\s*(?:bash|sh|zsh)\b/i.test(value) ||
        /\bInvoke-WebRequest\b[\s\S]{0,160}\|\s*iex\b/i.test(value),
    },
    {
      code: "credential-exfiltration",
      severity: "critical",
      message: "Bundle appears to collect secrets and transmit them remotely.",
      test: (value, lower) =>
        (/(process\.env|os\.environ|getenv\(|id_rsa|openai_api_key|aws_secret_access_key)/i.test(value) &&
          /(fetch\(|axios\.|requests\.(?:get|post)|curl\s+https?:\/\/|wget\s+https?:\/\/)/i.test(value)) ||
        (/(authorization: bearer|api[-_ ]?key)/i.test(value) &&
          /(discord|telegram|slack|webhook|ngrok|pastebin|transfer\.sh)/i.test(lower)),
    },
    {
      code: "destructive-filesystem",
      severity: "critical",
      message: "Bundle includes a destructive filesystem command.",
      test: (value) =>
        /\brm\s+-rf\s+(?:\/\b|~\/|\$HOME\b)/i.test(value) ||
        /\bdel\s+\/[a-z]+\s+[A-Z]:\\/i.test(value) ||
        /\bformat\s+[A-Z]:/i.test(value),
    },
    {
      code: "persistence-mechanism",
      severity: "critical",
      message: "Bundle attempts to create persistence on the host system.",
      test: (value) =>
        /\b(?:launchctl|crontab\s+-|systemctl\s+enable|systemctl\s+start|schtasks(?:\.exe)?)\b/i.test(
          value,
        ),
    },
    {
      code: "encoded-second-stage",
      severity: "critical",
      message: "Bundle includes encoded second-stage execution logic.",
      test: (value) =>
        /\b(?:base64\s+-d|frombase64string|Buffer\.from\([^)]*base64|atob\()[\s\S]{0,120}\b(?:eval|Function|exec|spawn|bash|sh)\b/i.test(
          value,
        ),
    },
    {
      code: "hidden-background-process",
      severity: "critical",
      message: "Bundle attempts to run a hidden or detached background process.",
      test: (value) =>
        /\b(?:nohup|disown)\b/i.test(value) ||
        /\bStart-Process\b[\s\S]{0,80}-WindowStyle\s+Hidden\b/i.test(value),
    },
  ];

  for (const rule of rules) {
    if (rule.test(text, lowerText)) {
      addFinding(findings, {
        code: rule.code,
        severity: rule.severity,
        path: filePath,
        message: rule.message,
      });
    }
  }
}

function assessUrl(
  urlValue: string,
  findings: CapabilitySecurityFinding[],
  filePath: string,
): void {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== "https:") {
      addFinding(findings, {
        code: "non-https-url",
        severity: "warning",
        path: filePath,
        message: "Bundle references a non-HTTPS URL.",
        detail: urlValue,
      });
    }

    if (
      /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(parsed.hostname) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)
    ) {
      addFinding(findings, {
        code: "direct-network-endpoint",
        severity: "warning",
        path: filePath,
        message: "Bundle targets a direct host or local network endpoint.",
        detail: urlValue,
      });
    }
  } catch {
    addFinding(findings, {
      code: "invalid-url",
      severity: "warning",
      path: filePath,
      message: "Bundle contains an invalid URL.",
      detail: urlValue,
    });
  }
}

function buildSkillDigest(stageDir: string): string {
  const manifestPath = path.join(stageDir, "manifest.json");
  const entries: Array<{ relativePath: string; content: Buffer | string }> = [];
  entries.push({
    relativePath: "manifest.json",
    content: fs.readFileSync(manifestPath),
  });
  const bundleDir = path.join(stageDir, "bundle");
  collectDirectoryEntries(bundleDir, "bundle", entries);
  return hashEntries(entries);
}

function buildActiveSkillDigest(manifestPath: string, bundleDir?: string | null): string {
  const entries: Array<{ relativePath: string; content: Buffer | string }> = [];
  entries.push({
    relativePath: "manifest.json",
    content: fs.readFileSync(manifestPath),
  });
  if (bundleDir && fs.existsSync(bundleDir)) {
    collectDirectoryEntries(bundleDir, "bundle", entries);
  }
  return hashEntries(entries);
}

function buildPackDigest(rootDir: string): string {
  const entries: Array<{ relativePath: string; content: Buffer | string }> = [];
  collectDirectoryEntries(rootDir, ".", entries);
  return hashEntries(entries);
}

export class CapabilityBundleSecurityService {
  private readonly quarantineRoot = path.join(getUserDataDir(), "quarantine", "capability-bundles");

  getSkillReportPath(managedSkillsDir: string, skillId: string): string {
    return path.join(managedSkillsDir, `${skillId}${SKILL_REPORT_SUFFIX}`);
  }

  getPackReportPath(packDir: string): string {
    return path.join(packDir, PACK_REPORT_FILENAME);
  }

  async scanSkillStage(context: SkillScanContext): Promise<CapabilitySecurityReport> {
    const findings: CapabilitySecurityFinding[] = [];
    const packages = new Map<string, PackageCandidate>();
    const texts: Array<{ path: string; content: string }> = [];

    const manifestPath = path.join(context.stageDir, "manifest.json");
    const manifestContent = fs.readFileSync(manifestPath, "utf-8");
    texts.push({ path: "manifest.json", content: manifestContent });

    const bundleDir = path.join(context.stageDir, "bundle");
    if (fs.existsSync(path.join(bundleDir, "scripts"))) {
      addFinding(findings, {
        code: "bundled-scripts",
        severity: "warning",
        path: "bundle/scripts",
        message: "Imported skill bundle includes executable helper scripts.",
      });
    }

    collectTextFiles(bundleDir, "bundle", findings, texts, true);

    for (const textEntry of texts) {
      scanTextContent(textEntry.path, textEntry.content, findings, packages);
    }

    const packageResults = await this.checkPackages(Array.from(packages.values()));
    const finalFindings = uniqueFindings(findings);
    for (const pkg of packageResults.results.filter((entry) => entry.malicious)) {
      addFinding(finalFindings, {
        code: "malicious-package",
        severity: "critical",
        message: `Package intelligence marked ${pkg.name} as malicious.`,
        detail: `${pkg.ecosystem} ${pkg.name}`,
      });
    }

    const verdict =
      finalFindings.some((finding) => finding.severity === "critical")
        ? context.managed
          ? "quarantined"
          : "warning"
        : finalFindings.length > 0 || packageResults.intelligenceUnavailable
          ? "warning"
          : "clean";

    return {
      bundleKind: "skill",
      bundleId: context.bundleId,
      displayName: context.displayName,
      source: context.source,
      managed: context.managed,
      scannedAt: new Date().toISOString(),
      verdict,
      summary: buildSummary(verdict, finalFindings, packageResults.intelligenceUnavailable),
      bundleDigest: buildSkillDigest(context.stageDir),
      findings: finalFindings,
      packagesChecked: packageResults.results,
      intelligenceUnavailable: packageResults.intelligenceUnavailable,
    };
  }

  async scanPluginPack(context: PackScanContext): Promise<CapabilitySecurityReport> {
    const findings: CapabilitySecurityFinding[] = [];
    const packages = new Map<string, PackageCandidate>();
    const texts: Array<{ path: string; content: string }> = [];
    const manifestPath = path.join(context.rootDir, "cowork.plugin.json");
    const manifestContent = fs.readFileSync(manifestPath, "utf-8");
    texts.push({ path: "cowork.plugin.json", content: manifestContent });

    if (context.manifest.main) {
      const resolvedMain = path.resolve(context.rootDir, context.manifest.main);
      if (!pathInside(context.rootDir, resolvedMain)) {
        addFinding(findings, {
          code: "manifest-path-escape",
          severity: "critical",
          path: "cowork.plugin.json",
          message: "Plugin main entry resolves outside the plugin root.",
          detail: context.manifest.main,
        });
      } else if (fs.existsSync(resolvedMain) && isLikelyTextFile(resolvedMain)) {
        texts.push({
          path: normalizeForHash(path.relative(context.rootDir, resolvedMain)),
          content: fs.readFileSync(resolvedMain, "utf-8"),
        });
      }
    }

    for (const connector of context.manifest.connectors || []) {
      this.scanConnector(connector, findings, packages, context.rootDir);
    }

    collectTextFiles(context.rootDir, ".", findings, texts, false);

    for (const textEntry of texts) {
      scanTextContent(textEntry.path, textEntry.content, findings, packages);
    }

    const packageResults = await this.checkPackages(Array.from(packages.values()));
    const finalFindings = uniqueFindings(findings);
    for (const pkg of packageResults.results.filter((entry) => entry.malicious)) {
      addFinding(finalFindings, {
        code: "malicious-package",
        severity: "critical",
        message: `Package intelligence marked ${pkg.name} as malicious.`,
        detail: `${pkg.ecosystem} ${pkg.name}`,
      });
    }

    const verdict =
      finalFindings.some((finding) => finding.severity === "critical")
        ? context.managed
          ? "quarantined"
          : "warning"
        : finalFindings.length > 0 || packageResults.intelligenceUnavailable
          ? "warning"
          : "clean";

    return {
      bundleKind: "plugin-pack",
      bundleId: context.bundleId,
      displayName: context.displayName,
      source: context.source,
      managed: context.managed,
      scannedAt: new Date().toISOString(),
      verdict,
      summary: buildSummary(verdict, finalFindings, packageResults.intelligenceUnavailable),
      bundleDigest: buildPackDigest(context.rootDir),
      findings: finalFindings,
      packagesChecked: packageResults.results,
      intelligenceUnavailable: packageResults.intelligenceUnavailable,
    };
  }

  private scanConnector(
    connector: DeclarativeConnector,
    findings: CapabilitySecurityFinding[],
    packages: Map<string, PackageCandidate>,
    rootDir: string,
  ): void {
    if (connector.type === "shell" && connector.shell) {
      addFinding(findings, {
        code: "shell-connector",
        severity: "warning",
        path: `connector:${connector.name}`,
        message: "Plugin pack exposes a shell connector.",
      });
      scanTextContent(`connector:${connector.name}`, connector.shell.command, findings, packages);
      if (connector.shell.cwd) {
        const resolvedCwd = path.resolve(rootDir, connector.shell.cwd);
        if (!pathInside(rootDir, resolvedCwd)) {
          addFinding(findings, {
            code: "connector-cwd-escape",
            severity: "critical",
            path: `connector:${connector.name}`,
            message: "Shell connector cwd resolves outside the plugin root.",
            detail: connector.shell.cwd,
          });
        }
      }
    }

    if (connector.type === "script" && connector.script) {
      addFinding(findings, {
        code: "script-connector",
        severity: "warning",
        path: `connector:${connector.name}`,
        message: "Plugin pack exposes an inline script connector.",
      });
      scanTextContent(`connector:${connector.name}`, connector.script.body, findings, packages);
    }

    if (connector.type === "http" && connector.http) {
      assessUrl(connector.http.url, findings, `connector:${connector.name}`);
      scanTextContent(`connector:${connector.name}`, connector.http.url, findings, packages);
      if (connector.http.body) {
        scanTextContent(`connector:${connector.name}`, connector.http.body, findings, packages);
      }
    }
  }

  private async checkPackages(
    candidates: PackageCandidate[],
  ): Promise<{
    results: CapabilitySecurityReport["packagesChecked"];
    intelligenceUnavailable: boolean;
  }> {
    const results: CapabilitySecurityReport["packagesChecked"] = [];
    let intelligenceUnavailable = false;

    for (const candidate of candidates.slice(0, MAX_PACKAGE_LOOKUPS)) {
      try {
        const response = await fetch("https://api.osv.dev/v1/query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            package: {
              name: candidate.name,
              ecosystem: candidate.ecosystem,
            },
          }),
        });

        if (!response.ok) {
          intelligenceUnavailable = true;
          results.push({
            ecosystem: candidate.ecosystem,
            name: candidate.name,
            malicious: false,
          });
          continue;
        }

        const payload = (await response.json()) as { vulns?: Array<{ id?: string; aliases?: string[] }> };
        const advisories = (payload.vulns || [])
          .flatMap((entry) => [entry.id, ...(entry.aliases || [])])
          .filter((value): value is string => typeof value === "string" && value.length > 0);
        const malicious = advisories.some((id) => /^MAL-/i.test(id));
        results.push({
          ecosystem: candidate.ecosystem,
          name: candidate.name,
          malicious,
          advisoryIds: malicious ? advisories.filter((id) => /^MAL-/i.test(id)) : undefined,
        });
      } catch (error) {
        intelligenceUnavailable = true;
        logger.warn(`OSV lookup failed for ${candidate.ecosystem}:${candidate.name}`, error);
        results.push({
          ecosystem: candidate.ecosystem,
          name: candidate.name,
          malicious: false,
        });
      }
    }

    return { results, intelligenceUnavailable };
  }

  persistActiveSkillReport(
    managedSkillsDir: string,
    skillId: string,
    report: CapabilitySecurityReport,
  ): void {
    writeJsonFile(this.getSkillReportPath(managedSkillsDir, skillId), report);
  }

  readActiveSkillReport(
    managedSkillsDir: string,
    skillId: string,
  ): CapabilitySecurityReport | null {
    return readJsonFile<CapabilitySecurityReport>(this.getSkillReportPath(managedSkillsDir, skillId));
  }

  persistActivePackReport(packDir: string, report: CapabilitySecurityReport): void {
    writeJsonFile(this.getPackReportPath(packDir), report);
  }

  readActivePackReport(packDir: string): CapabilitySecurityReport | null {
    return readJsonFile<CapabilitySecurityReport>(this.getPackReportPath(packDir));
  }

  activateSkillStage(
    stageDir: string,
    managedSkillsDir: string,
    skillId: string,
    report: CapabilitySecurityReport,
  ): void {
    const manifestTarget = path.join(managedSkillsDir, `${skillId}.json`);
    const bundleSource = path.join(stageDir, "bundle");
    const bundleTarget = path.join(managedSkillsDir, skillId);
    removeIfExists(manifestTarget);
    removeIfExists(bundleTarget);
    fs.copyFileSync(path.join(stageDir, "manifest.json"), manifestTarget);
    if (fs.existsSync(bundleSource)) {
      copyPath(bundleSource, bundleTarget);
    }
    this.persistActiveSkillReport(managedSkillsDir, skillId, report);
  }

  activatePluginPack(
    stageDir: string,
    targetDir: string,
    report: CapabilitySecurityReport,
  ): void {
    removeIfExists(targetDir);
    movePath(stageDir, targetDir);
    this.persistActivePackReport(targetDir, report);
  }

  quarantineSkillStage(
    stageDir: string,
    managedSkillsDir: string,
    skillId: string,
    displayName: string | undefined,
    source: CapabilitySecurityImportSource,
    report: CapabilitySecurityReport,
  ): QuarantinedImportRecord {
    const targetDir = this.createQuarantineDir("skill", skillId);
    movePath(stageDir, path.join(targetDir, QUARANTINE_PAYLOAD_DIR));
    const record = this.writeQuarantineRecord(targetDir, {
      version: 1,
      id: path.basename(targetDir),
      bundleKind: "skill",
      bundleId: skillId,
      displayName,
      source,
      managed: true,
      quarantinedAt: new Date().toISOString(),
      activeManifestPath: path.join(managedSkillsDir, `${skillId}.json`),
      activeBundleDir: path.join(managedSkillsDir, skillId),
    }, report);
    return record;
  }

  quarantineManagedSkill(
    managedSkillsDir: string,
    skillId: string,
    displayName: string | undefined,
    source: CapabilitySecurityImportSource,
    report: CapabilitySecurityReport,
  ): QuarantinedImportRecord {
    const manifestPath = path.join(managedSkillsDir, `${skillId}.json`);
    const bundleDir = path.join(managedSkillsDir, skillId);
    const targetDir = this.createQuarantineDir("skill", skillId);
    const payloadDir = path.join(targetDir, QUARANTINE_PAYLOAD_DIR);
    ensureDir(payloadDir);
    if (fs.existsSync(manifestPath)) {
      movePath(manifestPath, path.join(payloadDir, "manifest.json"));
    }
    if (fs.existsSync(bundleDir)) {
      movePath(bundleDir, path.join(payloadDir, "bundle"));
    }
    removeIfExists(this.getSkillReportPath(managedSkillsDir, skillId));
    return this.writeQuarantineRecord(targetDir, {
      version: 1,
      id: path.basename(targetDir),
      bundleKind: "skill",
      bundleId: skillId,
      displayName,
      source,
      managed: true,
      quarantinedAt: new Date().toISOString(),
      activeManifestPath: manifestPath,
      activeBundleDir: bundleDir,
    }, report);
  }

  quarantinePluginPackStage(
    stageDir: string,
    packId: string,
    displayName: string | undefined,
    source: CapabilitySecurityImportSource,
    activePackDir: string,
    report: CapabilitySecurityReport,
  ): QuarantinedImportRecord {
    const targetDir = this.createQuarantineDir("plugin-pack", packId);
    movePath(stageDir, path.join(targetDir, QUARANTINE_PAYLOAD_DIR));
    return this.writeQuarantineRecord(targetDir, {
      version: 1,
      id: path.basename(targetDir),
      bundleKind: "plugin-pack",
      bundleId: packId,
      displayName,
      source,
      managed: true,
      quarantinedAt: new Date().toISOString(),
      activePackDir,
    }, report);
  }

  quarantineManagedPluginPack(
    packDir: string,
    packId: string,
    displayName: string | undefined,
    report: CapabilitySecurityReport,
  ): QuarantinedImportRecord {
    const targetDir = this.createQuarantineDir("plugin-pack", packId);
    movePath(packDir, path.join(targetDir, QUARANTINE_PAYLOAD_DIR));
    return this.writeQuarantineRecord(targetDir, {
      version: 1,
      id: path.basename(targetDir),
      bundleKind: "plugin-pack",
      bundleId: packId,
      displayName,
      source: "managed",
      managed: true,
      quarantinedAt: new Date().toISOString(),
      activePackDir: packDir,
    }, report);
  }

  async verifyManagedSkillIntegrity(
    managedSkillsDir: string,
    skillId: string,
    displayName?: string,
  ): Promise<{ allowed: boolean; report: CapabilitySecurityReport | null }> {
    const manifestPath = path.join(managedSkillsDir, `${skillId}.json`);
    if (!fs.existsSync(manifestPath)) {
      return { allowed: false, report: null };
    }

    const bundleDir = fs.existsSync(path.join(managedSkillsDir, skillId))
      ? path.join(managedSkillsDir, skillId)
      : null;
    const storedReport = this.readActiveSkillReport(managedSkillsDir, skillId);
    const currentDigest = buildActiveSkillDigest(manifestPath, bundleDir);

    if (storedReport && storedReport.bundleDigest === currentDigest) {
      return { allowed: true, report: storedReport };
    }

    const stageDir = path.join(managedSkillsDir, `.security-scan-${skillId}-${Date.now()}`);
    ensureDir(stageDir);
    try {
      fs.copyFileSync(manifestPath, path.join(stageDir, "manifest.json"));
      if (bundleDir && fs.existsSync(bundleDir)) {
        copyPath(bundleDir, path.join(stageDir, "bundle"));
      }
      const report = await this.scanSkillStage({
        bundleId: skillId,
        displayName,
        source: "managed",
        managed: true,
        stageDir,
      });

      if (storedReport && storedReport.bundleDigest !== currentDigest) {
        report.findings = uniqueFindings([
          ...report.findings,
          {
            code: "digest-mismatch",
            severity: "critical",
            path: "manifest.json",
            message: "Managed skill changed after its last approved scan.",
          },
        ]);
        report.verdict = "quarantined";
        report.summary = buildSummary(report.verdict, report.findings, report.intelligenceUnavailable);
        this.quarantineManagedSkill(managedSkillsDir, skillId, displayName, "managed", report);
        return { allowed: false, report };
      }

      if (report.verdict === "quarantined") {
        this.quarantineManagedSkill(managedSkillsDir, skillId, displayName, "managed", report);
        return { allowed: false, report };
      }

      this.persistActiveSkillReport(managedSkillsDir, skillId, report);
      return { allowed: true, report };
    } finally {
      removeIfExists(stageDir);
    }
  }

  async inspectUnmanagedSkill(
    skill: CustomSkill,
  ): Promise<CapabilitySecurityReport | null> {
    const filePath = skill.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const stageDir = path.join(getUserDataDir(), ".skill-scan-cache", `${skill.id}-${Date.now()}`);
    ensureDir(stageDir);
    try {
      fs.copyFileSync(filePath, path.join(stageDir, "manifest.json"));
      const companionDir = path.join(path.dirname(filePath), skill.id);
      if (fs.existsSync(companionDir)) {
        copyPath(companionDir, path.join(stageDir, "bundle"));
      }
      const report = await this.scanSkillStage({
        bundleId: skill.id,
        displayName: skill.name,
        source: "unmanaged-local",
        managed: false,
        stageDir,
      });
      return report.verdict === "warning" ? report : null;
    } finally {
      removeIfExists(stageDir);
    }
  }

  async inspectPluginPackForDiscovery(
    pluginDir: string,
    manifest: PluginManifest,
    managed: boolean,
    source: CapabilitySecurityImportSource,
  ): Promise<{ allowed: boolean; report: CapabilitySecurityReport | null }> {
    const storedReport = managed ? this.readActivePackReport(pluginDir) : null;
    const currentDigest = buildPackDigest(pluginDir);

    if (storedReport && storedReport.bundleDigest === currentDigest) {
      return { allowed: true, report: storedReport };
    }

    const report = await this.scanPluginPack({
      bundleId: manifest.name,
      displayName: manifest.displayName,
      source,
      managed,
      rootDir: pluginDir,
      manifest,
    });

    if (managed && storedReport && storedReport.bundleDigest !== currentDigest) {
      report.findings = uniqueFindings([
        ...report.findings,
        {
          code: "digest-mismatch",
          severity: "critical",
          path: "cowork.plugin.json",
          message: "Managed plugin pack changed after its last approved scan.",
        },
      ]);
      report.verdict = "quarantined";
      report.summary = buildSummary(report.verdict, report.findings, report.intelligenceUnavailable);
      this.quarantineManagedPluginPack(pluginDir, manifest.name, manifest.displayName, report);
      return { allowed: false, report };
    }

    if (managed && report.verdict === "quarantined") {
      this.quarantineManagedPluginPack(pluginDir, manifest.name, manifest.displayName, report);
      return { allowed: false, report };
    }

    if (managed) {
      this.persistActivePackReport(pluginDir, report);
    }

    return { allowed: true, report: report.verdict === "warning" || managed ? report : null };
  }

  listQuarantinedImports(): QuarantinedImportRecord[] {
    const roots = [
      path.join(this.quarantineRoot, "skill"),
      path.join(this.quarantineRoot, "plugin-pack"),
    ];
    const records: QuarantinedImportRecord[] = [];

    for (const rootDir of roots) {
      if (!fs.existsSync(rootDir)) {
        continue;
      }

      for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const record = this.readQuarantineRecord(path.join(rootDir, entry.name));
        if (record) {
          records.push(record);
        }
      }
    }

    return records.sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt));
  }

  getImportSecurityReport(
    request: ImportSecurityReportRequest,
    managedSkillsDir?: string,
    activePackDir?: string,
  ): CapabilitySecurityReport | null {
    if (request.location === "quarantine" && request.quarantineId) {
      const record = this.readQuarantineRecord(this.findQuarantineRecordDir(request.quarantineId));
      return record?.report || null;
    }

    if (request.bundleKind === "skill" && managedSkillsDir) {
      return this.readActiveSkillReport(managedSkillsDir, request.bundleId);
    }

    if (request.bundleKind === "plugin-pack" && activePackDir) {
      return this.readActivePackReport(activePackDir);
    }

    return null;
  }

  async retryQuarantinedImport(recordId: string): Promise<RetryQuarantinedImportResult> {
    const recordDir = this.findQuarantineRecordDir(recordId);
    if (!recordDir) {
      return {
        success: false,
        restored: false,
        outcome: { state: "failed", summary: "Quarantine record not found" },
        error: "Quarantine record not found",
      };
    }

    const metadata = readJsonFile<QuarantineMetadata>(
      path.join(recordDir, QUARANTINE_METADATA_FILENAME),
    );
    const report = readJsonFile<CapabilitySecurityReport>(
      path.join(recordDir, QUARANTINE_REPORT_FILENAME),
    );
    if (!metadata || !report) {
      return {
        success: false,
        restored: false,
        outcome: { state: "failed", summary: "Quarantine metadata is missing" },
        error: "Quarantine metadata is missing",
      };
    }

    const payloadDir = path.join(recordDir, QUARANTINE_PAYLOAD_DIR);
    if (metadata.bundleKind === "skill") {
      const retryReport = await this.scanSkillStage({
        bundleId: metadata.bundleId,
        displayName: metadata.displayName,
        source: metadata.source,
        managed: true,
        stageDir: payloadDir,
      });

      if (retryReport.verdict === "quarantined") {
        writeJsonFile(path.join(recordDir, QUARANTINE_REPORT_FILENAME), retryReport);
        const updated = this.readQuarantineRecord(recordDir);
        return {
          success: false,
          restored: false,
          outcome: { state: "quarantined", summary: retryReport.summary, report: retryReport },
          item: updated,
          error: retryReport.summary,
        };
      }

      if (!metadata.activeManifestPath) {
        return {
          success: false,
          restored: false,
          outcome: { state: "failed", summary: "Missing skill restore target" },
          error: "Missing skill restore target",
        };
      }

      const managedSkillsDir = path.dirname(metadata.activeManifestPath);
      const skillId = metadata.bundleId;
      const stageClone = path.join(managedSkillsDir, `.security-restore-${skillId}-${Date.now()}`);
      copyPath(payloadDir, stageClone);
      this.activateSkillStage(stageClone, managedSkillsDir, skillId, retryReport);
      removeIfExists(stageClone);
      removeIfExists(recordDir);
      return {
        success: true,
        restored: true,
        outcome: {
          state: retryReport.verdict === "warning" ? "installed_with_warning" : "installed",
          summary: retryReport.summary,
          report: retryReport,
        },
        item: null,
      };
    }

    const manifest = readJsonFile<PluginManifest>(path.join(payloadDir, "cowork.plugin.json"));
    if (!manifest || !metadata.activePackDir) {
      return {
        success: false,
        restored: false,
        outcome: { state: "failed", summary: "Missing plugin pack restore target" },
        error: "Missing plugin pack restore target",
      };
    }

    const retryReport = await this.scanPluginPack({
      bundleId: metadata.bundleId,
      displayName: metadata.displayName,
      source: metadata.source,
      managed: true,
      rootDir: payloadDir,
      manifest,
    });

    if (retryReport.verdict === "quarantined") {
      writeJsonFile(path.join(recordDir, QUARANTINE_REPORT_FILENAME), retryReport);
      const updated = this.readQuarantineRecord(recordDir);
      return {
        success: false,
        restored: false,
        outcome: { state: "quarantined", summary: retryReport.summary, report: retryReport },
        item: updated,
        error: retryReport.summary,
      };
    }

    const restoreClone = path.join(path.dirname(metadata.activePackDir), `.security-restore-${Date.now()}`);
    copyPath(payloadDir, restoreClone);
    this.activatePluginPack(restoreClone, metadata.activePackDir, retryReport);
    removeIfExists(recordDir);
    return {
      success: true,
      restored: true,
      outcome: {
        state: retryReport.verdict === "warning" ? "installed_with_warning" : "installed",
        summary: retryReport.summary,
        report: retryReport,
      },
      item: null,
    };
  }

  removeQuarantinedImport(recordId: string): { success: boolean; error?: string } {
    const recordDir = this.findQuarantineRecordDir(recordId);
    if (!recordDir) {
      return { success: false, error: "Quarantine record not found" };
    }
    removeIfExists(recordDir);
    return { success: true };
  }

  private createQuarantineDir(bundleKind: CapabilityBundleKind, bundleId: string): string {
    const kindRoot = path.join(this.quarantineRoot, bundleKind);
    ensureDir(kindRoot);
    const safeBundleId = bundleId.replace(/[^a-z0-9._-]+/gi, "-");
    const recordId = `${safeBundleId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const targetDir = path.join(kindRoot, recordId);
    ensureDir(targetDir);
    return targetDir;
  }

  private writeQuarantineRecord(
    targetDir: string,
    metadata: QuarantineMetadata,
    report: CapabilitySecurityReport,
  ): QuarantinedImportRecord {
    writeJsonFile(path.join(targetDir, QUARANTINE_METADATA_FILENAME), metadata);
    writeJsonFile(path.join(targetDir, QUARANTINE_REPORT_FILENAME), report);
    return {
      id: metadata.id,
      bundleKind: metadata.bundleKind,
      bundleId: metadata.bundleId,
      displayName: metadata.displayName,
      quarantinedAt: metadata.quarantinedAt,
      summary: report.summary,
      report,
    };
  }

  private readQuarantineRecord(targetDir: string | null): QuarantinedImportRecord | null {
    if (!targetDir) {
      return null;
    }
    const metadata = readJsonFile<QuarantineMetadata>(path.join(targetDir, QUARANTINE_METADATA_FILENAME));
    const report = readJsonFile<CapabilitySecurityReport>(path.join(targetDir, QUARANTINE_REPORT_FILENAME));
    if (!metadata || !report) {
      return null;
    }
    return {
      id: metadata.id,
      bundleKind: metadata.bundleKind,
      bundleId: metadata.bundleId,
      displayName: metadata.displayName,
      quarantinedAt: metadata.quarantinedAt,
      summary: report.summary,
      report,
    };
  }

  private findQuarantineRecordDir(recordId: string): string | null {
    for (const bundleKind of ["skill", "plugin-pack"] as const) {
      const candidate = path.join(this.quarantineRoot, bundleKind, recordId);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}

let securityService: CapabilityBundleSecurityService | null = null;

export function getCapabilityBundleSecurityService(): CapabilityBundleSecurityService {
  if (!securityService) {
    securityService = new CapabilityBundleSecurityService();
  }
  return securityService;
}
