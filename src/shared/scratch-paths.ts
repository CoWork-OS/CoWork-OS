/**
 * Working files the agent writes for itself (caches, temp folders, CoWork's own `.cowork`
 * folder): never deliverables, and not listed as a turn's changes.
 */
const SCRATCH_PATH_SEGMENTS = new Set([
  ".cowork",
  ".git",
  ".cache",
  ".venv",
  ".tmp",
  "__pycache__",
  "node_modules",
  "scratch",
  "tmp",
  "temp",
  "venv",
]);
const SCRATCH_ABSOLUTE_PREFIX_RE = /^\/(?:private\/)?(?:tmp|var\/folders)\//;
const SCRATCH_FILE_NAME_RE = /^(?:~\$|\.DS_Store$|\.~lock\.)/;

function normalizeScratchPath(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\\/g, "/") : "";
}

export function isScratchOutputPath(filePath: string): boolean {
  const normalized = normalizeScratchPath(filePath);
  if (!normalized) return true;
  if (SCRATCH_ABSOLUTE_PREFIX_RE.test(normalized)) return true;
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1] || "";
  if (SCRATCH_FILE_NAME_RE.test(fileName)) return true;
  return segments.slice(0, -1).some((segment) => SCRATCH_PATH_SEGMENTS.has(segment.toLowerCase()));
}
