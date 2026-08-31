import * as fs from "fs";
import * as path from "path";
import type { WorkspacePathAliasPolicy } from "../../shared/types";

export const DEFAULT_WORKSPACE_ALIAS_ROOTS = ["/workspace"] as const;

export interface WorkspacePathAliasMatch {
  originalPath: string;
  aliasRoot: string;
  suffix: string;
  normalizedPath: string;
  normalizedAbsolutePath: string;
  sourceExists: boolean;
}

export interface TaskRootPathRewriteMatch {
  originalPath: string;
  normalizedPath: string;
  normalizedAbsolutePath: string;
  pinnedRoot: string;
  sourceExists: boolean;
  normalizedSourceAbsolutePath: string;
}

function normalizeAliasRoot(value: string): string {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!normalized) return "";
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    return normalized;
  }
  return `/${normalized.replace(/^\/+/, "")}`;
}

function isWithinWorkspace(absolutePath: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, absolutePath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function detectWorkspacePathAlias(
  inputPath: string,
  workspacePath: string,
  aliasRoots: readonly string[] = DEFAULT_WORKSPACE_ALIAS_ROOTS,
): WorkspacePathAliasMatch | null {
  const rawPath = String(inputPath || "").trim();
  if (!rawPath || !path.isAbsolute(rawPath)) return null;

  const workspaceRoot = path.resolve(workspacePath);
  const normalizedInput = rawPath.replace(/\\/g, "/");
  const normalizedInputLower = normalizedInput.toLowerCase();

  for (const rawAliasRoot of aliasRoots) {
    const aliasRoot = normalizeAliasRoot(rawAliasRoot);
    if (!aliasRoot) continue;

    const normalizedAliasRoot = aliasRoot;
    const normalizedAliasRootLower = normalizedAliasRoot.toLowerCase();
    const isExact = normalizedInputLower === normalizedAliasRootLower;
    const isNested = normalizedInputLower.startsWith(`${normalizedAliasRootLower}/`);
    if (!isExact && !isNested) continue;

    const suffix = normalizedInput.slice(normalizedAliasRoot.length).replace(/^\/+/, "");
    const normalizedAbsolutePath = suffix ? path.resolve(workspaceRoot, suffix) : workspaceRoot;
    if (!isWithinWorkspace(normalizedAbsolutePath, workspaceRoot)) {
      return null;
    }

    const relative = path.relative(workspaceRoot, normalizedAbsolutePath).replace(/\\/g, "/");
    const normalizedPath = relative || ".";
    const sourceExists = fs.existsSync(path.resolve(rawPath));
    return {
      originalPath: rawPath,
      aliasRoot: normalizedAliasRoot,
      suffix,
      normalizedPath,
      normalizedAbsolutePath,
      sourceExists,
    };
  }

  return null;
}

export function shouldRewriteWorkspaceAliasPath(
  match: WorkspacePathAliasMatch,
  policy: WorkspacePathAliasPolicy,
  opts?: { requireSourceMissing?: boolean },
): boolean {
  if (policy !== "rewrite_and_retry") return false;
  if (opts?.requireSourceMissing && match.sourceExists) return false;
  return true;
}

export function isWorkspaceAliasFailureMessage(message: string): boolean {
  const lower = String(message || "").toLowerCase();
  if (!lower.trim()) return false;
  return (
    /enoent|no such file or directory|path does not exist|search path must be within workspace/i.test(
      lower,
    ) || /outside workspace boundary|path traversal outside workspace/i.test(lower)
  );
}

function normalizeWorkspaceRelativePath(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function isNormalizedPathWithinWorkspace(candidatePath: string, workspaceRoot: string): boolean {
  const absolute = path.resolve(workspaceRoot, candidatePath);
  return isWithinWorkspace(absolute, workspaceRoot);
}

export function detectTaskRootPathRewrite(
  inputPath: string,
  workspacePath: string,
  pinnedRoot: string,
  _opts?: { requireSourceMissing?: boolean },
): TaskRootPathRewriteMatch | null {
  const rawInput = String(inputPath || "").trim();
  if (!rawInput) return null;
  if (path.isAbsolute(rawInput)) return null;
  if (rawInput.startsWith("../")) return null;

  const workspaceRoot = path.resolve(workspacePath);
  const normalizedPinnedRoot = normalizeWorkspaceRelativePath(pinnedRoot);
  if (!normalizedPinnedRoot || normalizedPinnedRoot === ".") return null;
  if (!isNormalizedPathWithinWorkspace(normalizedPinnedRoot, workspaceRoot)) return null;

  const normalizedInput = normalizeWorkspaceRelativePath(rawInput);
  if (!normalizedInput || normalizedInput === ".") return null;
  if (
    normalizedInput === normalizedPinnedRoot ||
    normalizedInput.startsWith(`${normalizedPinnedRoot}/`)
  ) {
    return null;
  }

  const normalizedSourceAbsolutePath = path.resolve(workspaceRoot, normalizedInput);
  const sourceExists = fs.existsSync(normalizedSourceAbsolutePath);

  const normalizedPath = `${normalizedPinnedRoot}/${normalizedInput}`.replace(/\/+/g, "/");
  if (!isNormalizedPathWithinWorkspace(normalizedPath, workspaceRoot)) return null;
  const normalizedAbsolutePath = path.resolve(workspaceRoot, normalizedPath);

  return {
    originalPath: rawInput,
    normalizedPath,
    normalizedAbsolutePath,
    pinnedRoot: normalizedPinnedRoot,
    sourceExists,
    normalizedSourceAbsolutePath,
  };
}
