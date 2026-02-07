import { FileTools } from './file-tools';
import { GlobTools } from './glob-tools';

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
  }>;
  skippedFiles: Array<{
    path: string;
    reason: string;
  }>;
  warnings: string[];
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function splitPatterns(patterns: string[]): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];

  for (const raw of patterns) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (!p) continue;
    if (p.startsWith('!') && p.length > 1) {
      exclude.push(p.slice(1).trim());
    } else {
      include.push(p);
    }
  }

  return { include, exclude };
}

export async function readFilesByPatterns(
  input: ReadFilesInput,
  deps: { globTools: GlobTools; fileTools: FileTools }
): Promise<ReadFilesResult> {
  if (!input || !Array.isArray(input.patterns) || input.patterns.length === 0) {
    throw new Error('read_files requires a non-empty patterns array');
  }

  const basePath = typeof input.path === 'string' && input.path.trim().length > 0 ? input.path.trim() : '.';
  const maxFiles = clampInt(input.maxFiles, 12, 1, 100);
  const maxResults = clampInt(input.maxResults, 500, 1, 5000);
  const maxTotalChars = clampInt(input.maxTotalChars, 30000, 1000, 200000);

  const { include, exclude } = splitPatterns(input.patterns);
  if (include.length === 0) {
    throw new Error('read_files requires at least one include pattern');
  }

  const warnings: string[] = [];
  const matched = new Map<string, { size: number }>();

  let anyPatternTruncated = false;
  for (const pattern of include) {
    const res = await deps.globTools.glob({ pattern, path: basePath, maxResults });
    if (!res.success) {
      warnings.push(`Glob failed for pattern "${pattern}": ${res.error || 'unknown error'}`);
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
    const res = await deps.globTools.glob({ pattern, path: basePath, maxResults });
    if (!res.success) {
      warnings.push(`Exclude glob failed for pattern "!${pattern}": ${res.error || 'unknown error'}`);
      continue;
    }
    if (res.truncated) {
      anyPatternTruncated = true;
      warnings.push(`Exclude glob results truncated for pattern "!${pattern}" (maxResults=${maxResults})`);
    }
    for (const m of res.matches) {
      matched.delete(m.path);
    }
  }

  const allMatchedPaths = Array.from(matched.keys()).sort();
  const selectedPaths = allMatchedPaths.slice(0, maxFiles);

  const skippedFiles: ReadFilesResult['skippedFiles'] = [];
  const files: ReadFilesResult['files'] = [];

  let truncated = false;
  if (allMatchedPaths.length > maxFiles) {
    truncated = true;
    skippedFiles.push({
      path: '(additional files)',
      reason: `Matched ${allMatchedPaths.length} files; limited to maxFiles=${maxFiles}`,
    });
  }

  let totalChars = 0;
  for (const filePath of selectedPaths) {
    try {
      const read = await deps.fileTools.readFile(filePath);

      let content = read.content;
      const remaining = maxTotalChars - totalChars;
      if (content.length > remaining) {
        truncated = true;
        if (remaining > 200) {
          content = content.slice(0, Math.max(0, remaining - 120)) + '\n\n[... truncated by read_files ...]';
        } else {
          skippedFiles.push({
            path: filePath,
            reason: `Skipped: maxTotalChars=${maxTotalChars} reached`,
          });
          break;
        }
      }

      totalChars += content.length;
      files.push({
        path: filePath,
        size: read.size,
        truncated: read.truncated,
        format: read.format,
        content,
      });

      if (totalChars >= maxTotalChars) {
        truncated = true;
        break;
      }
    } catch (error: any) {
      skippedFiles.push({
        path: filePath,
        reason: error?.message ? String(error.message) : 'Failed to read file',
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
    skipped: skippedFiles.length,
    truncated,
    files,
    skippedFiles,
    warnings,
  };
}

