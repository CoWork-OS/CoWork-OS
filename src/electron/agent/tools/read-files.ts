import { FileTools } from "./file-tools";
import { GlobTools } from "./glob-tools";

export type ReadFilesInput = {
  patterns: string[];
  path?: string;
  maxFiles?: number;
  maxResults?: number;
  maxTotalChars?: number;
};

export type ReadFilesResult = {
  success: boolean;
  basePath: string;
  includePatterns: string[];
  excludePatterns: string[];
  totalMatched: number;
  included: number;
  skipped: number;
  truncated: boolean;
  files: Array<{
    path: string;
    size: number;
    truncated?: boolean;
    format?: string;
    content: string;
    window?: { start: number; end: number; total: number };
    nextStartChar?: number;
  }>;
  skippedFiles: Array<{
    path: string;
    reason: string;
  }>;
  warnings: string[];
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function splitPatterns(patterns: string[]): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];

  for (const raw of patterns) {
    const p = typeof raw === "string" ? raw.trim() : "";
    if (!p) continue;
    if (p.startsWith("!") && p.length > 1) {
      exclude.push(p.slice(1).trim());
    } else {
      include.push(p);
    }
  }

  return { include, exclude };
}

export async function readFilesByPatterns(
  input: ReadFilesInput,
  deps: { globTools: GlobTools; fileTools: FileTools },
): Promise<ReadFilesResult> {
  if (!input || !Array.isArray(input.patterns) || input.patterns.length === 0) {
    throw new Error("read_files requires a non-empty patterns array");
  }

  const basePath =
    typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : ".";
  const maxFiles = clampInt(input.maxFiles, 12, 1, 100);
  const maxResults = clampInt(input.maxResults, 500, 1, 5000);
  const maxTotalChars = clampInt(input.maxTotalChars, 30000, 1000, 200000);

  const { include, exclude } = splitPatterns(input.patterns);
  if (include.length === 0) {
    throw new Error("read_files requires at least one include pattern");
  }

  const warnings: string[] = [];
  const matched = new Map<string, { size: number }>();

  const results = await deps.globTools.globMany({
    patterns: [...include, ...exclude],
    path: basePath,
    maxResults,
  });
  let resultIndex = 0;
  let anyPatternTruncated = false;
  for (const pattern of include) {
    const res = results[resultIndex++];
    if (!res.success) {
      warnings.push(`Glob failed for pattern "${pattern}": ${res.error || "unknown error"}`);
      continue;
    }
    if (res.truncated) {
      anyPatternTruncated = true;
      warnings.push(`Glob results truncated for pattern "${pattern}" (maxResults=${maxResults})`);
    }
    for (const m of res.matches) {
      if (!matched.has(m.path)) {
        matched.set(m.path, { size: m.size });
      }
    }
  }

  for (const pattern of exclude) {
    const res = results[resultIndex++];
    if (!res.success) {
      warnings.push(
        `Exclude glob failed for pattern "!${pattern}": ${res.error || "unknown error"}`,
      );
      continue;
    }
    if (res.truncated) {
      anyPatternTruncated = true;
      warnings.push(
        `Exclude glob results truncated for pattern "!${pattern}" (maxResults=${maxResults})`,
      );
    }
    for (const m of res.matches) {
      matched.delete(m.path);
    }
  }

  const allMatchedPaths = Array.from(matched.keys()).sort();
  const selectedPaths = allMatchedPaths.slice(0, maxFiles);

  const skippedFiles: ReadFilesResult["skippedFiles"] = [];
  const files: ReadFilesResult["files"] = [];

  let truncated = false;
  if (allMatchedPaths.length > maxFiles) {
    truncated = true;
    skippedFiles.push({
      path: "(additional files)",
      reason: `Matched ${allMatchedPaths.length} files; limited to maxFiles=${maxFiles}`,
    });
  }

  let totalChars = 0;
  for (const [fileIndex, filePath] of selectedPaths.entries()) {
    try {
      const read = await deps.fileTools.readFile(filePath);

      let content = read.content;
      const remaining = maxTotalChars - totalChars;
      if (content.length > remaining) {
        truncated = true;
        if (remaining > 200) {
          content =
            content.slice(0, Math.max(0, remaining - 120)) +
            "\n\n[... truncated by read_files ...]";
        } else {
          for (const omittedPath of selectedPaths.slice(fileIndex)) {
            skippedFiles.push({
              path: omittedPath,
              reason: `Skipped: maxTotalChars=${maxTotalChars} reached`,
            });
          }
          break;
        }
      }

      totalChars += content.length;
      const contentClipped = content !== read.content;
      const fileTruncated = Boolean(read.truncated) || contentClipped;
      truncated ||= fileTruncated;
      files.push({
        path: filePath,
        size: read.size,
        truncated: fileTruncated,
        format: read.format,
        content,
        // A read_file window is resumable only when all of that window was
        // delivered. Reusing its end after our own clipping would skip source.
        ...(!contentClipped ? { window: read.window, nextStartChar: read.nextStartChar } : {}),
      });

      if (totalChars >= maxTotalChars) {
        truncated = true;
        for (const omittedPath of selectedPaths.slice(fileIndex + 1)) {
          skippedFiles.push({
            path: omittedPath,
            reason: `Skipped: maxTotalChars=${maxTotalChars} reached`,
          });
        }
        break;
      }
    } catch (error: Any) {
      skippedFiles.push({
        path: filePath,
        reason: error?.message ? String(error.message) : "Failed to read file",
      });
    }
  }

  if (anyPatternTruncated && !truncated) {
    // Truncation can happen even if we didn't hit our own caps. Surface it via "truncated" to be explicit.
    truncated = true;
  }

  return {
    success: true,
    basePath,
    includePatterns: include,
    excludePatterns: exclude,
    totalMatched: allMatchedPaths.length,
    included: files.length,
    skipped: allMatchedPaths.length - files.length,
    truncated,
    files,
    skippedFiles,
    warnings,
  };
}
