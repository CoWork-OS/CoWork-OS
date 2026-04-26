import * as fs from "fs";
import * as path from "path";

export const COWORK_PRIVATE_ROOT = ".cowork";
export const COWORK_TASK_TMP_ROOT = ".cowork/tmp";
export const COWORK_AUTOMATED_OUTPUT_ROOT = ".cowork/automated-outputs";

const DEFAULT_LOCAL_EXCLUDE_PATHS = [
  COWORK_TASK_TMP_ROOT,
  COWORK_AUTOMATED_OUTPUT_ROOT,
];

const excludeUpdates = new Set<string>();

interface GitDirInfo {
  repoRoot: string;
  gitDir: string;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function resolveGitDir(repoRoot: string, gitPath: string): string | null {
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  try {
    const content = fs.readFileSync(gitPath, "utf-8");
    const match = content.match(/^gitdir:\s*(.+)\s*$/im);
    if (!match?.[1]) return null;
    const gitDir = match[1].trim();
    return path.resolve(repoRoot, gitDir);
  } catch {
    return null;
  }
}

function findGitDir(startPath: string): GitDirInfo | null {
  let current = path.resolve(startPath);

  while (true) {
    const gitPath = path.join(current, ".git");
    const gitDir = resolveGitDir(current, gitPath);
    if (gitDir) {
      return { repoRoot: current, gitDir };
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function buildExcludeEntry(repoRoot: string, workspacePath: string, workspaceRelativePath: string): string | null {
  const absoluteTarget = path.resolve(workspacePath, workspaceRelativePath);
  const relativeToRepo = path.relative(repoRoot, absoluteTarget);
  if (!relativeToRepo || relativeToRepo.startsWith("..") || path.isAbsolute(relativeToRepo)) {
    return null;
  }

  const entry = toPosixPath(relativeToRepo).replace(/\/?$/, "/");
  return entry.startsWith("/") ? entry : entry;
}

export function ensureCoWorkPrivatePathsExcluded(
  workspacePath: string,
  relativePaths: string[] = DEFAULT_LOCAL_EXCLUDE_PATHS,
): void {
  const git = findGitDir(workspacePath);
  if (!git) return;

  const entries = relativePaths
    .map((relativePath) => buildExcludeEntry(git.repoRoot, workspacePath, relativePath))
    .filter((entry): entry is string => Boolean(entry));
  if (entries.length === 0) return;

  const cacheKey = `${git.gitDir}:${entries.join("|")}`;
  if (excludeUpdates.has(cacheKey)) return;

  const excludePath = path.join(git.gitDir, "info", "exclude");

  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const content = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
    const existing = new Set(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const missing = entries.filter((entry) => !existing.has(entry) && !existing.has(`/${entry}`));
    if (missing.length === 0) {
      excludeUpdates.add(cacheKey);
      return;
    }

    const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    const comment = content.includes("# CoWork OS local scratch and generated outputs")
      ? ""
      : "# CoWork OS local scratch and generated outputs\n";
    fs.writeFileSync(excludePath, `${content}${newline}${comment}${missing.join("\n")}\n`, "utf-8");
    excludeUpdates.add(cacheKey);
  } catch {
    // Best effort only. Failure here must not block normal workspace tools.
  }
}

export function isCoWorkPrivateGeneratedPath(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath).replace(/^\.\//, "");
  return (
    normalized === COWORK_TASK_TMP_ROOT ||
    normalized.startsWith(`${COWORK_TASK_TMP_ROOT}/`) ||
    normalized === COWORK_AUTOMATED_OUTPUT_ROOT ||
    normalized.startsWith(`${COWORK_AUTOMATED_OUTPUT_ROOT}/`)
  );
}
