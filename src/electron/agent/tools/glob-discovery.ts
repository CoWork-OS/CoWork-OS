import * as fs from "node:fs";
import * as path from "node:path";
import type { Workspace } from "../../../shared/types";
import { evaluateWorkspaceFilesystemAccess } from "../../security/access-profile-paths";

export interface GlobResult {
  success: boolean;
  pattern: string;
  matches: Array<{ path: string; size: number; modified: string }>;
  totalMatches: number;
  truncated: boolean;
  scanTruncated?: boolean;
  truncationReason?: string;
  error?: string;
}
export interface GlobDiscoveryInput {
  patterns: string[];
  path?: string;
  maxResults?: number;
}
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".build",
  "release",
  "out",
  ".cowork",
  ".cache",
  ".parcel-cache",
  ".turbo",
  "coverage",
  ".next",
  ".nuxt",
  "__pycache__",
  ".pytest_cache",
  "venv",
  ".venv",
  "env",
  ".env",
]);
const posix = (value: string) => value.split(path.sep).join("/");
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
function generated(relative: string): boolean {
  const normalized = posix(relative).toLowerCase();
  return (
    normalized.split("/").some((part) => SKIP_DIRS.has(part)) ||
    `${normalized}/`.startsWith(".claude/worktrees/")
  );
}
function expandBraces(pattern: string, budget = { remaining: 128 }): string[] {
  const match = pattern.match(/\{([^}]+)\}/);
  if (!match) {
    if (--budget.remaining < 0) throw new Error("Glob pattern exceeds the 128-expansion limit");
    return [pattern];
  }
  return match[1]
    .split(",")
    .flatMap((option) => expandBraces(pattern.replace(match[0], option.trim()), budget));
}
function regexFor(patterns: string[]): RegExp {
  const parts = patterns.map((pattern) =>
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\u0001")
      .replace(/\*\*/g, "\u0002")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0001/g, "(?:.*/)?")
      .replace(/\u0002/g, ".*"),
  );
  return new RegExp(`^(?:${parts.join("|")})$`, "i");
}

/** Synchronous filesystem and policy work is confined to file-discovery-worker. */
export function discoverGlob(workspace: Workspace, input: GlobDiscoveryInput) {
  if (input.patterns.length > 128)
    throw new Error("File discovery supports at most 128 patterns per request");
  const root = path.resolve(workspace.path);
  const requested = input.path ? path.resolve(root, input.path) : root;
  const access = evaluateWorkspaceFilesystemAccess(workspace, requested, "read");
  if (access.decision !== "allow") {
    throw new Error(
      access.reason === "memory_repo_unavailable"
        ? "The memory folder is not readable in this task"
        : "Search path must be within workspace (or the memory folder)",
    );
  }
  const base = access.path;
  if (!fs.existsSync(base)) throw new Error(`Path does not exist: ${input.path || "."}`);
  if (base !== root && generated(within(root, base) ? path.relative(root, base) : base)) {
    throw new Error(`Search path is a generated or dependency directory: ${input.path || "."}`);
  }
  const maxResults = Number.isFinite(input.maxResults)
    ? Math.max(1, Math.floor(input.maxResults!))
    : 100;
  const maxBuffer = Math.min(Math.max(maxResults * 5, 500), 5000);
  const stats = { directoriesRead: 0, filesVisited: 0 };
  const directoryCache = new Map<string, fs.Dirent[]>();
  const readDirectory = (directory: string) => {
    let entries = directoryCache.get(directory);
    if (!entries) {
      stats.directoriesRead++;
      entries = fs.readdirSync(directory, { withFileTypes: true });
      directoryCache.set(directory, entries);
    }
    return entries;
  };
  type Match = { path: string; size: number; mtime: number };
  const states = input.patterns.map((pattern) => {
    try {
      if (pattern.length > 1024) throw new Error("Glob pattern exceeds the 1024-character limit");
      const anchored = pattern.startsWith("./");
      const expanded = expandBraces(pattern.replace(/^(\.\/)+/, ""));
      const regex = regexFor(expanded);
      const recursiveBasename = !anchored && expanded.some((part) => !part.includes("/"));
      const directoryMatchers = expanded.flatMap((part) => {
        const segments = part.split("/").slice(0, -1);
        return segments.map((_, index) => regexFor([segments.slice(0, index + 1).join("/")]));
      });
      // Basename patterns deliberately retain recursive matching. Directory-qualified patterns
      // can start at their fixed prefix; resolve its spelling without losing case-insensitive globs.
      const scopes = expanded.flatMap((part) => {
        const segments = part.split("/");
        if (segments.includes("..") || part.startsWith("/")) return [];
        const directories = segments.slice(0, -1);
        let current = [base];
        for (const segment of directories) {
          if (/[*?]/.test(segment)) break;
          current = current.flatMap((directory) => {
            try {
              return readDirectory(directory)
                .filter(
                  (entry) =>
                    entry.isDirectory() && entry.name.toLowerCase() === segment.toLowerCase(),
                )
                .map((entry) => path.join(directory, entry.name))
                .filter(
                  (candidate) =>
                    !generated(path.relative(base, candidate)) &&
                    evaluateWorkspaceFilesystemAccess(workspace, candidate, "read").decision ===
                      "allow",
                );
            } catch {
              return [];
            }
          });
        }
        return current;
      });
      return {
        pattern,
        regex,
        anchored,
        recursiveBasename,
        directoryMatchers,
        scopes,
        matches: [] as Match[],
        truncated: false,
        error: undefined as string | undefined,
      };
    } catch (error) {
      return {
        pattern,
        regex: /$a/,
        anchored: false,
        recursiveBasename: false,
        directoryMatchers: [] as RegExp[],
        scopes: [],
        matches: [] as Match[],
        truncated: false,
        error: (error as Error).message,
      };
    }
  });
  const scopes = [...new Set(states.flatMap((state) => state.scopes))];
  const scanRoots = scopes.filter(
    (scope) => !scopes.some((other) => other !== scope && within(other, scope)),
  );
  const maxFiles = Math.min(Math.max(maxResults * 300, 5000), 50000);
  const maxDirectories = Math.min(Math.max(maxResults * 50, 1000), 10000);
  const started = Date.now();
  let directoriesVisited = 0;
  let scanTruncated = false;
  const complete = () => states.every((state) => state.error || state.truncated);
  const walk = (current: string, depth: number) => {
    if (depth > 50 || scanTruncated || complete()) return;
    if (++directoriesVisited > maxDirectories || Date.now() - started > 25_000) {
      scanTruncated = true;
      return;
    }
    if (current !== base && generated(path.relative(base, current))) return;
    let entries: fs.Dirent[];
    try {
      entries = readDirectory(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanTruncated || complete()) break;
      if (Date.now() - started > 25_000) {
        scanTruncated = true;
        break;
      }
      if (!entry.isDirectory() && !entry.isFile()) continue; // Never follow symlinks.
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && generated(path.relative(base, full))) continue;
      if (entry.isDirectory()) {
        const relative = posix(path.relative(base, full));
        if (
          states.some(
            (state) =>
              !state.error &&
              !state.truncated &&
              (state.recursiveBasename ||
                state.directoryMatchers.some((regex) => regex.test(relative))),
          )
        ) {
          if (evaluateWorkspaceFilesystemAccess(workspace, full, "read").decision === "allow") {
            walk(full, depth + 1);
          }
        }
        continue;
      }
      if (++stats.filesVisited > maxFiles) {
        scanTruncated = true;
        break;
      }
      const relative = posix(path.relative(base, full));
      const matching = states.filter(
        (state) =>
          !state.error &&
          !state.truncated &&
          (state.regex.test(relative) || (!state.anchored && state.regex.test(entry.name))),
      );
      if (!matching.length) continue;
      if (evaluateWorkspaceFilesystemAccess(workspace, full, "read").decision !== "allow") continue;
      let file: fs.Stats;
      try {
        file = fs.statSync(full);
      } catch {
        continue;
      }
      for (const state of matching) {
        if (state.matches.length >= maxBuffer) {
          state.truncated = true;
          continue;
        }
        state.matches.push({ path: full, size: file.size, mtime: file.mtimeMs });
      }
    }
  };
  for (const scope of scanRoots)
    walk(scope, posix(path.relative(base, scope)).split("/").filter(Boolean).length);
  const results: GlobResult[] = states.map((state) => {
    state.matches.sort((a, b) => b.mtime - a.mtime);
    const partial = scanTruncated || state.truncated;
    return {
      success: !state.error,
      pattern: state.pattern,
      matches: state.matches.slice(0, maxResults).map((file) => ({
        path: within(root, base) ? path.relative(root, file.path) : file.path,
        size: file.size,
        modified: new Date(file.mtime).toISOString(),
      })),
      totalMatches: state.matches.length,
      truncated: partial || state.matches.length > maxResults,
      ...(partial
        ? {
            scanTruncated: true,
            truncationReason:
              "The scan stopped before covering every file, so totalMatches is a lower bound and a missing match does not mean the file is absent.",
          }
        : {}),
      ...(state.error ? { error: state.error } : {}),
    };
  });
  return { results, stats };
}
