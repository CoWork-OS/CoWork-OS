import type { TaskEvent, TaskOutputSummary } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

export type LatexPdfPair = {
  sourcePath: string;
  pdfPath: string;
};

const TEX_EXT_RE = /\.tex$/i;
const PDF_EXT_RE = /\.pdf$/i;

function normalizePath(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\\/g, "/") : "";
}

function dirname(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx >= 0 ? filePath.slice(0, idx) : ".";
}

function basenameWithoutExt(filePath: string): string {
  const name = filePath.split("/").pop() || filePath;
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(0, idx).toLowerCase() : name.toLowerCase();
}

function sameStemAndFolder(left: string, right: string): boolean {
  return dirname(left) === dirname(right) && basenameWithoutExt(left) === basenameWithoutExt(right);
}

export function findLatexPdfPair(
  events: TaskEvent[] | undefined,
  outputSummary?: TaskOutputSummary | null,
): LatexPdfPair | null {
  const texPaths = new Set<string>();
  const pdfPaths = new Set<string>();
  const orderedPdfPaths: string[] = [];

  const addPath = (rawPath: unknown) => {
    const filePath = normalizePath(rawPath);
    if (!filePath) return;
    if (TEX_EXT_RE.test(filePath)) {
      texPaths.add(filePath);
      return;
    }
    if (PDF_EXT_RE.test(filePath)) {
      pdfPaths.add(filePath);
      orderedPdfPaths.push(filePath);
    }
  };

  for (const filePath of [
    ...(outputSummary?.created || []),
    ...(outputSummary?.modifiedFallback || []),
    outputSummary?.primaryOutputPath,
  ]) {
    addPath(filePath);
  }

  for (const event of events || []) {
    const effectiveType = getEffectiveTaskEventType(event);
    if (
      effectiveType !== "artifact_created" &&
      effectiveType !== "file_created" &&
      effectiveType !== "file_modified"
    ) {
      continue;
    }
    const eventPath = normalizePath(event.payload?.path || event.payload?.to || event.payload?.from);
    const sourcePath = normalizePath(event.payload?.sourcePath);
    addPath(eventPath);
    addPath(sourcePath);
    if (PDF_EXT_RE.test(eventPath) && TEX_EXT_RE.test(sourcePath)) {
      return { sourcePath, pdfPath: eventPath };
    }
  }

  for (const pdfPath of orderedPdfPaths) {
    for (const sourcePath of texPaths) {
      if (sameStemAndFolder(sourcePath, pdfPath)) {
        return { sourcePath, pdfPath };
      }
    }
  }

  for (const pdfPath of pdfPaths) {
    for (const sourcePath of texPaths) {
      if (sameStemAndFolder(sourcePath, pdfPath)) {
        return { sourcePath, pdfPath };
      }
    }
  }

  return null;
}
