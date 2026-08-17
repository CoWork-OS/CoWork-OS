import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { extractPdfText } from "../utils/pdf-text";

const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([".docx", ".pdf", ".md", ".txt"]);
const IGNORED_DIRECTORIES = new Set([
  ".cowork",
  ".git",
  "node_modules",
  "dist",
  "build",
  "release",
]);

export interface DocumentAnalysisSource {
  path: string;
  relativePath: string;
  text: string;
  checksum: string;
}

export interface DocumentAnalysisChunk {
  index: number;
  start: number;
  end: number;
  total: number;
  content: string;
}

function normalizeForMatch(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isOfficeLockFile(name: string): boolean {
  return name.startsWith("~$");
}

async function collectDocuments(root: string, maxDepth = 4): Promise<string[]> {
  const results: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isOfficeLockFile(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        await visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SUPPORTED_DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  };
  await visit(root, 0);
  return results;
}

/** Locate the most likely source document without involving the model in path discovery. */
export async function discoverDocumentForAnalysis(
  workspacePath: string,
  taskText: string,
): Promise<string | null> {
  const candidates = await collectDocuments(workspacePath);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const normalizedTask = normalizeForMatch(taskText);
  const taskTokens = new Set(normalizedTask.split(/\s+/).filter((token) => token.length >= 3));
  const ranked = candidates.map((candidate) => {
    const relative = path.relative(workspacePath, candidate);
    const stem = normalizeForMatch(path.basename(candidate, path.extname(candidate)));
    const stemTokens = stem.split(/\s+/).filter((token) => token.length >= 3);
    const exactStem = stem.length >= 8 && normalizedTask.includes(stem);
    const tokenMatches = stemTokens.filter((token) => taskTokens.has(token)).length;
    return {
      candidate,
      relative,
      score: (exactStem ? 1000 : 0) + tokenMatches * 10 - relative.split(path.sep).length,
    };
  });
  ranked.sort(
    (left, right) => right.score - left.score || left.relative.localeCompare(right.relative),
  );
  return ranked[0]?.candidate || null;
}

export async function extractDocumentForAnalysis(
  workspacePath: string,
  documentPath: string,
): Promise<DocumentAnalysisSource> {
  const resolvedWorkspace = await fs.realpath(workspacePath);
  const resolvedDocument = await fs.realpath(documentPath);
  if (
    resolvedDocument !== resolvedWorkspace &&
    !resolvedDocument.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    throw new Error("Document analysis source must be inside the workspace.");
  }

  const extension = path.extname(resolvedDocument).toLowerCase();
  let text = "";
  if (extension === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: resolvedDocument });
    text = result.value || "";
  } else if (extension === ".pdf") {
    const result = await extractPdfText(resolvedDocument, {
      includeOcr: true,
      maxFallbackPages: 400,
      maxFallbackCharsPerPage: 4_000,
      maxFallbackOcrPages: 20,
    });
    text = result.text || "";
  } else if (extension === ".md" || extension === ".txt") {
    text = await fs.readFile(resolvedDocument, "utf8");
  } else {
    throw new Error(`Unsupported long-document analysis type: ${extension || "unknown"}`);
  }

  if (!text.trim()) {
    throw new Error(`No readable text was extracted from ${path.basename(resolvedDocument)}.`);
  }
  return {
    path: resolvedDocument,
    relativePath: path.relative(resolvedWorkspace, resolvedDocument),
    text,
    checksum: createHash("sha256").update(text).digest("hex"),
  };
}

/**
 * Split source text into stable, overlapping windows. Boundaries prefer paragraph
 * breaks, then line breaks, and never create a gap in source coverage.
 */
export function splitDocumentForAnalysis(
  text: string,
  maxChars = 24_000,
  overlapChars = 400,
): DocumentAnalysisChunk[] {
  const source = String(text || "");
  if (!source) return [];
  const boundedMax = Math.max(4_000, Math.floor(maxChars));
  const boundedOverlap = Math.max(0, Math.min(Math.floor(overlapChars), boundedMax / 4));
  const chunks: DocumentAnalysisChunk[] = [];
  let start = 0;

  while (start < source.length) {
    const hardEnd = Math.min(source.length, start + boundedMax);
    let end = hardEnd;
    if (hardEnd < source.length) {
      const minimumBoundary = start + Math.floor(boundedMax * 0.6);
      const paragraphBreak = source.lastIndexOf("\n\n", hardEnd);
      const lineBreak = source.lastIndexOf("\n", hardEnd);
      const candidate = paragraphBreak >= minimumBoundary ? paragraphBreak + 2 : lineBreak;
      if (candidate >= minimumBoundary) end = candidate;
    }
    if (end <= start) end = hardEnd;

    chunks.push({
      index: chunks.length,
      start,
      end,
      total: source.length,
      content: source.slice(start, end),
    });
    if (end >= source.length) break;
    const nextStart = Math.max(start + 1, end - boundedOverlap);
    start = nextStart;
  }

  return chunks;
}
