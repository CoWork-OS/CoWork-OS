import path from "path";
import type { WorkspaceKitFileStatus, WorkspaceKitIssue } from "../../shared/types";
import { computeWorkspaceKitStatus } from "./kit-status";
import { getArgValue, hasArgFlag } from "../utils/runtime-mode";

export function usage(): string {
  return [
    "Usage: node dist/electron/electron/context/kit-lint-cli.js [workspace-path] [--workspace <path>] [--json] [--strict]",
    "",
    "Options:",
    "  --workspace <path>  Workspace root to inspect (defaults to current working directory)",
    "  --json              Print raw WorkspaceKitStatus JSON",
    "  --strict            Exit non-zero on warnings or missing tracked files",
    "  --help              Show this help text",
  ].join("\n");
}

function getPositionalWorkspaceArg(argv: string[]): string | undefined {
  return argv.slice(2).find((arg) => typeof arg === "string" && !arg.startsWith("-"));
}

function formatIssue(issue: WorkspaceKitIssue): string {
  const level = issue.level === "error" ? "ERROR" : "WARN";
  return `    - [${level}] ${issue.code}: ${issue.message}`;
}

function formatFile(entry: WorkspaceKitFileStatus): string[] {
  const lines: string[] = [];
  const title = entry.title ? ` — ${entry.title}` : "";
  const status = entry.exists ? "present" : "missing";
  lines.push(`- ${entry.relPath}${title}`);
  lines.push(`  status: ${status}`);

  if (typeof entry.revisionCount === "number") {
    lines.push(`  revisions: ${entry.revisionCount}`);
  }

  if (entry.specialHandling) {
    lines.push(`  special: ${entry.specialHandling}`);
  }

  if (entry.stale) {
    lines.push("  stale: yes");
  }

  if (entry.modifiedAt) {
    lines.push(`  modifiedAt: ${new Date(entry.modifiedAt).toISOString()}`);
  }

  if (typeof entry.sizeBytes === "number") {
    lines.push(`  sizeBytes: ${entry.sizeBytes}`);
  }

  if (entry.issues?.length) {
    lines.push(...entry.issues.map(formatIssue));
  }

  return lines;
}

export async function runWorkspaceKitLintCli(argv = process.argv): Promise<number> {
  if (argv !== process.argv) {
    process.argv = argv;
  }

  if (hasArgFlag("--help") || hasArgFlag("-h")) {
    console.log(usage());
    return 0;
  }

  const rawWorkspace =
    getArgValue("--workspace") || getPositionalWorkspaceArg(argv) || process.cwd();
  const workspacePath = path.resolve(rawWorkspace);
  const emitJson = hasArgFlag("--json");
  const strict = hasArgFlag("--strict");

  const status = await computeWorkspaceKitStatus(workspacePath, workspacePath);
  const lintWarnings = status.lintWarningCount || 0;
  const lintErrors = status.lintErrorCount || 0;
  const missingEntries = status.files.filter((entry) => !entry.exists);
  const filesWithIssues = status.files.filter(
    (entry) => !entry.exists || (entry.issues?.length || 0) > 0,
  );
  const fail =
    !status.hasKitDir ||
    lintErrors > 0 ||
    (strict && (lintWarnings > 0 || missingEntries.length > 0));

  if (emitJson) {
    console.log(JSON.stringify(status, null, 2));
    if (fail) {
      process.exitCode = 1;
    }
    return fail ? 1 : 0;
  }

  console.log("Workspace Kit Lint");
  console.log(`workspace: ${workspacePath}`);
  console.log(`kitDir: ${status.hasKitDir ? "present" : "missing"}`);
  console.log(`missingTrackedEntries: ${status.missingCount}`);
  console.log(`warnings: ${lintWarnings}`);
  console.log(`errors: ${lintErrors}`);

  if (status.onboarding) {
    console.log(`bootstrapPresent: ${status.onboarding.bootstrapPresent ? "yes" : "no"}`);
    if (status.onboarding.bootstrapSeededAt) {
      console.log(
        `bootstrapSeededAt: ${new Date(status.onboarding.bootstrapSeededAt).toISOString()}`,
      );
    }
    if (status.onboarding.onboardingCompletedAt) {
      console.log(
        `onboardingCompletedAt: ${new Date(status.onboarding.onboardingCompletedAt).toISOString()}`,
      );
    }
  }

  if (filesWithIssues.length === 0) {
    console.log("\nNo kit issues detected.");
  } else {
    console.log("\nTracked entries with findings:");
    for (const entry of filesWithIssues) {
      console.log(formatFile(entry).join("\n"));
    }
  }

  if (fail) {
    process.exitCode = 1;
  }

  return fail ? 1 : 0;
}

if (require.main === module) {
  runWorkspaceKitLintCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kit-lint] ${message}`);
    process.exitCode = 1;
  });
}
