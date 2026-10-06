/**
 * Which paths the workspace markdown index (`<workspace>/.cowork`) never covers. Pure, so
 * the index service, the database worker and the retention job share it.
 */

/** The markdown memory index always covers `<workspace>/.cowork`. */
const INDEX_ROOT_DIRNAME = ".cowork";

/**
 * Paths (relative to the index root) that hold generated or bulk artifacts, not
 * memory: kit history snapshots, subconscious and chronicle artifacts, raw
 * transcripts, retired topic packs and daily summaries, lock files, scratch files and
 * scratchpads.
 */
export const EXCLUDED_INDEX_PREFIXES = [
  ".history/",
  "subconscious/",
  "chronicle/",
  "memory/transcripts/",
  "memory/topics/",
  "memory/summaries/",
  "memory/locks/",
  "tmp/",
] as const;
export const EXCLUDED_INDEX_BASENAME = /^scratchpad[-_.]/i;

/** Whether an index-root-relative path is excluded from the markdown index. */
export function isExcludedMarkdownIndexPath(relPath: string): boolean {
  const normalized = String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
  if (!normalized) return true;
  // Rows written when the index was rooted at the workspace root (or outside
  // `.cowork`) are stale under the normalized root.
  if (normalized.startsWith("../") || normalized.startsWith(`${INDEX_ROOT_DIRNAME}/`)) return true;
  if (EXCLUDED_INDEX_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".history")) return true;
  return EXCLUDED_INDEX_BASENAME.test(segments[segments.length - 1] || "");
}
