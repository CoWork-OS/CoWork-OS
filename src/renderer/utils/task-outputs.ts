import { TaskEvent, TaskOutputSummary } from "../../shared/types";

function normalizePath(raw: string): string {
  return raw.trim().replace(/\\/g, "/");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toUniqueNormalizedPaths(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isNonEmptyString(value)) continue;
    const normalized = normalizePath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function getParentFolder(filePath: string): string {
  const normalized = normalizePath(filePath);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return ".";
  return normalized.slice(0, idx);
}

function deriveFolders(paths: string[]): string[] {
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const filePath of paths) {
    const folder = getParentFolder(filePath);
    if (seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }
  return folders;
}

function mapToSortedPaths(map: Map<string, number>): string[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([filePath]) => filePath);
}

function buildSummary(created: string[], modifiedFallback: string[]): TaskOutputSummary | null {
  const effective = created.length > 0 ? created : modifiedFallback;
  if (effective.length === 0) return null;

  return {
    created,
    ...(modifiedFallback.length > 0 ? { modifiedFallback } : {}),
    primaryOutputPath: effective[0],
    outputCount: effective.length,
    folders: deriveFolders(effective),
  };
}

export function sanitizeTaskOutputSummary(raw: unknown): TaskOutputSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as {
    created?: unknown[];
    modifiedFallback?: unknown[];
    primaryOutputPath?: unknown;
    outputCount?: unknown;
    folders?: unknown[];
  };

  const created = toUniqueNormalizedPaths(Array.isArray(candidate.created) ? candidate.created : []);
  const modifiedFallback = toUniqueNormalizedPaths(
    Array.isArray(candidate.modifiedFallback) ? candidate.modifiedFallback : [],
  );
  const effective = created.length > 0 ? created : modifiedFallback;
  if (effective.length === 0) return null;

  const providedPrimary = isNonEmptyString(candidate.primaryOutputPath)
    ? normalizePath(candidate.primaryOutputPath)
    : "";
  const primaryOutputPath =
    providedPrimary && effective.includes(providedPrimary) ? providedPrimary : effective[0];
  const foldersFromPayload = toUniqueNormalizedPaths(
    Array.isArray(candidate.folders) ? candidate.folders : [],
  );
  const outputCount =
    typeof candidate.outputCount === "number" &&
    Number.isFinite(candidate.outputCount) &&
    candidate.outputCount > 0
      ? Math.floor(candidate.outputCount)
      : effective.length;

  return {
    created,
    ...(modifiedFallback.length > 0 ? { modifiedFallback } : {}),
    primaryOutputPath,
    outputCount,
    folders: foldersFromPayload.length > 0 ? foldersFromPayload : deriveFolders(effective),
  };
}

export function deriveTaskOutputSummaryFromEvents(events: TaskEvent[]): TaskOutputSummary | null {
  const created = new Map<string, number>();
  const modified = new Map<string, number>();

  for (const event of events) {
    if (event.type === "file_created") {
      const path = event.payload?.path;
      if (!isNonEmptyString(path)) continue;
      if (event.payload?.type === "directory") continue;
      created.set(normalizePath(path), event.timestamp || Date.now());
      continue;
    }

    if (event.type === "artifact_created") {
      const path = event.payload?.path;
      if (!isNonEmptyString(path)) continue;
      created.set(normalizePath(path), event.timestamp || Date.now());
      continue;
    }

    if (event.type === "file_modified") {
      const path = event.payload?.path || event.payload?.to || event.payload?.from;
      if (!isNonEmptyString(path)) continue;
      modified.set(normalizePath(path), event.timestamp || Date.now());
    }
  }

  const createdPaths = mapToSortedPaths(created);
  const modifiedPaths = mapToSortedPaths(modified);
  return buildSummary(createdPaths, modifiedPaths);
}

export function resolveTaskOutputSummaryFromCompletionEvent(
  event: TaskEvent,
  fallbackEvents?: TaskEvent[],
): TaskOutputSummary | null {
  if (event.type !== "task_completed") return null;

  const fromPayload = sanitizeTaskOutputSummary(event.payload?.outputSummary);
  if (fromPayload) return fromPayload;

  if (Array.isArray(fallbackEvents) && fallbackEvents.length > 0) {
    return deriveTaskOutputSummaryFromEvents(fallbackEvents);
  }

  return null;
}

export function hasTaskOutputs(summary: TaskOutputSummary | null | undefined): summary is TaskOutputSummary {
  return !!summary && summary.outputCount > 0;
}

export function getFileName(filePath: string): string {
  const normalized = normalizePath(filePath);
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

export function getPrimaryOutputFileName(summary: TaskOutputSummary | null | undefined): string {
  if (!summary?.primaryOutputPath) return "";
  return getFileName(summary.primaryOutputPath);
}

export function getPrimaryOutputFolder(summary: TaskOutputSummary | null | undefined): string {
  if (!summary?.primaryOutputPath) return ".";
  return getParentFolder(summary.primaryOutputPath);
}

export function formatOutputLocationLabel(summary: TaskOutputSummary | null | undefined): string {
  const primaryFolder = getPrimaryOutputFolder(summary);
  return primaryFolder === "." ? "Workspace root" : `${primaryFolder}/`;
}
