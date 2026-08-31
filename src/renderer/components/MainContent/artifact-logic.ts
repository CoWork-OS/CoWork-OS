import type { TaskEvent } from "../../../shared/types";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import { resolveTaskOutputSummaryFromCompletionEvent } from "../../utils/task-outputs";
import {
  isSpreadsheetArtifactFile,
  isSpreadsheetMimeType,
} from "../../../shared/spreadsheet-formats";
import {
  isWordDocumentArtifactFile,
  isWordDocumentMimeType,
} from "../../../shared/document-formats";
import {
  isPresentationArtifactFile,
  isPresentationMimeType,
} from "../../../shared/presentation-formats";
import { isWebPageArtifactFile, isWebPageMimeType } from "../../../shared/web-page-formats";
import { IMAGE_FILE_EXT_RE, VIDEO_FILE_EXT_RE, HTML_FILE_EXT_RE } from "./main-content-constants";

export type GeneratedInlinePreviewKind =
  | "image"
  | "video"
  | "html"
  | "spreadsheet"
  | "presentation"
  | "document";
export const END_OF_TASK_ARTIFACT_KINDS = new Set<GeneratedInlinePreviewKind>([
  "html",
  "spreadsheet",
  "presentation",
  "document",
]);
const END_OF_TASK_ARTIFACT_COLLAPSED_LIMIT = 5;
const END_OF_TASK_ARTIFACT_CARD_ESTIMATED_HEIGHT = 86;
const END_OF_TASK_ARTIFACT_STACK_CHROME_ESTIMATED_HEIGHT = 28;
const END_OF_TASK_ARTIFACT_SHOW_MORE_ESTIMATED_HEIGHT = 48;

export interface EndOfTaskArtifactCard {
  path: string;
  kind: GeneratedInlinePreviewKind;
  eventId?: string;
  lastReferenceIndex: number;
  lastReferenceTimestamp: number;
}

export interface EndOfTaskArtifactStack {
  anchorEventIndex: number;
  artifacts: EndOfTaskArtifactCard[];
}

export function getVisibleEndOfTaskArtifactCards(
  artifacts: EndOfTaskArtifactCard[],
  expanded: boolean,
): { visibleArtifacts: EndOfTaskArtifactCard[]; hiddenCount: number } {
  if (expanded || artifacts.length <= END_OF_TASK_ARTIFACT_COLLAPSED_LIMIT) {
    return { visibleArtifacts: artifacts, hiddenCount: 0 };
  }

  return {
    visibleArtifacts: artifacts.slice(0, END_OF_TASK_ARTIFACT_COLLAPSED_LIMIT),
    hiddenCount: artifacts.length - END_OF_TASK_ARTIFACT_COLLAPSED_LIMIT,
  };
}

export function estimateEndOfTaskArtifactStackHeight(
  artifacts: EndOfTaskArtifactCard[],
  expanded: boolean,
): number {
  const { visibleArtifacts, hiddenCount } = getVisibleEndOfTaskArtifactCards(artifacts, expanded);
  return (
    END_OF_TASK_ARTIFACT_STACK_CHROME_ESTIMATED_HEIGHT +
    visibleArtifacts.length * END_OF_TASK_ARTIFACT_CARD_ESTIMATED_HEIGHT +
    (hiddenCount > 0 ? END_OF_TASK_ARTIFACT_SHOW_MORE_ESTIMATED_HEIGHT : 0)
  );
}

const GENERATED_ARTIFACT_LINK_EXTENSIONS =
  "html?|xlsx?|xlsm|xlsb|csv|tsv|ods|numbers|gsheet|md|markdown|docx|docm|dotx|dotm|doc|rtf|odt|ott|pages|pptx|pptm?|potx|potm|ppsx|ppsm";

const GENERATED_ARTIFACT_LINK_RE = new RegExp(
  "`([^`\\r\\n]+\\.(?:" +
    GENERATED_ARTIFACT_LINK_EXTENSIONS +
    "))`|((?:\\.{1,2}/|[\\w@.-]+/)?[\\w@./-]+\\.(?:" +
    GENERATED_ARTIFACT_LINK_EXTENSIONS +
    "))",
  "gi",
);

const NON_OUTPUT_ARTIFACT_REFERENCE_RE =
  /\b(?:planned artifacts?|intended (?:export )?(?:contract|outputs?|paths?)|what i attempted|not successfully (?:written|saved|created)|file persistence (?:is )?(?:still )?blocked|blocked by|blocked part|could not (?:write|save|create)|cannot (?:write|save|create)|failed to (?:write|save|create)|writes? failed|shell\/write failure|disk-write failure)\b/i;
const OUTPUT_ARTIFACT_REFERENCE_RE =
  /\b(?:(?:now|successfully)\s+(?:saved|created|wrote|written|generated|exported|produced|rendered)|(?:saved|created|wrote|generated|exported|produced|rendered|validated)\s+(?:files?|artifacts?|outputs?)|artifact ready|output ready|file:|output:)\b/i;

export function getInlinePreviewKindForGeneratedFile(args: {
  path?: unknown;
  mimeType?: unknown;
  type?: unknown;
}): GeneratedInlinePreviewKind | null {
  const filePath = typeof args.path === "string" ? args.path : "";
  const mimeType = typeof args.mimeType === "string" ? args.mimeType.toLowerCase() : "";
  const fileType = typeof args.type === "string" ? args.type.toLowerCase() : "";

  if (fileType === "image" || mimeType.startsWith("image/") || IMAGE_FILE_EXT_RE.test(filePath)) {
    return "image";
  }

  if (fileType === "video" || mimeType.startsWith("video/") || VIDEO_FILE_EXT_RE.test(filePath)) {
    return "video";
  }

  if (
    fileType === "html" ||
    isWebPageMimeType(mimeType) ||
    isWebPageArtifactFile(filePath) ||
    HTML_FILE_EXT_RE.test(filePath)
  ) {
    return "html";
  }

  if (
    fileType === "spreadsheet" ||
    isSpreadsheetMimeType(mimeType) ||
    isSpreadsheetArtifactFile(filePath)
  ) {
    return "spreadsheet";
  }

  if (
    fileType === "presentation" ||
    isPresentationMimeType(mimeType) ||
    isPresentationArtifactFile(filePath)
  ) {
    return "presentation";
  }

  if (
    fileType === "document" ||
    fileType === "docx" ||
    fileType === "markdown" ||
    isWordDocumentMimeType(mimeType) ||
    isWordDocumentArtifactFile(filePath)
  ) {
    return "document";
  }

  return null;
}

function normalizeGeneratedArtifactPathCandidate(candidate: string): string {
  const normalized = candidate
    .trim()
    .replace(/^[<"'""'']+/g, "")
    .replace(/[>"'""'',.;:)\]}]+$/g, "");

  if (!normalized || /^(?:https?:)?\/\//i.test(normalized)) return "";
  if (!getInlinePreviewKindForGeneratedFile({ path: normalized })) return "";
  return normalized;
}

function getLineAtOffset(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const lineEnd = text.indexOf("\n", offset);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
}

function getPreviousNonEmptyLines(text: string, offset: number, limit: number): string[] {
  const lines: string[] = [];
  let cursor = text.lastIndexOf("\n", Math.max(0, offset - 1));
  while (cursor > 0 && lines.length < limit) {
    const previousLineEnd = cursor;
    const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1;
    const line = text.slice(previousLineStart, previousLineEnd).trim();
    if (line) lines.push(line);
    cursor = previousLineStart - 1;
  }
  return lines;
}

function hasPositiveArtifactReference(line: string): boolean {
  return OUTPUT_ARTIFACT_REFERENCE_RE.test(line);
}

function isNonOutputArtifactReferenceContext(text: string, start: number): boolean {
  const currentLine = getLineAtOffset(text, start).trim();
  if (hasPositiveArtifactReference(currentLine)) return false;
  if (NON_OUTPUT_ARTIFACT_REFERENCE_RE.test(currentLine)) return true;

  for (const line of getPreviousNonEmptyLines(text, start, 4)) {
    if (hasPositiveArtifactReference(line)) return false;
    if (NON_OUTPUT_ARTIFACT_REFERENCE_RE.test(line)) return true;
  }
  return false;
}

export function extractGeneratedArtifactPathsFromText(text: string, limit = 8): string[] {
  if (!text.trim()) return [];
  GENERATED_ARTIFACT_LINK_RE.lastIndex = 0;

  const seen = new Set<string>();
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = GENERATED_ARTIFACT_LINK_RE.exec(text)) && paths.length < limit) {
    const prefix = text.slice(Math.max(0, match.index - 8), match.index);
    if (/https?:\/\/$/i.test(prefix)) continue;
    if (isNonOutputArtifactReferenceContext(text, match.index)) {
      continue;
    }
    const candidate = normalizeGeneratedArtifactPathCandidate(match[1] || match[2] || "");
    if (!candidate) continue;
    const dedupeKey = candidate.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    paths.push(candidate);
  }
  return paths;
}

export function getInlinePreviewKindForTaskEvent(
  event: TaskEvent,
): GeneratedInlinePreviewKind | null {
  const effectiveType = getEffectiveTaskEventType(event);
  if (
    effectiveType !== "file_created" &&
    effectiveType !== "file_modified" &&
    effectiveType !== "artifact_created"
  ) {
    return null;
  }

  return getInlinePreviewKindForGeneratedFile({
    path: event.payload?.path || event.payload?.from,
    mimeType: event.payload?.mimeType,
    type: event.payload?.type,
  });
}

function normalizeArtifactCardKey(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").toLowerCase();
}

function getArtifactCardDisplayKey(filePath: string, kind: GeneratedInlinePreviewKind): string {
  const normalized = normalizeArtifactCardKey(filePath);
  const fileName = normalized.split("/").filter(Boolean).pop() || normalized;
  return `${kind}:${fileName}`;
}

export function getTaskEventArtifactPaths(event: TaskEvent, eventStream?: TaskEvent[]): string[] {
  const effectiveType = getEffectiveTaskEventType(event);
  const paths: unknown[] = [];

  if (
    effectiveType === "file_created" ||
    effectiveType === "file_modified" ||
    effectiveType === "artifact_created"
  ) {
    paths.push(event.payload?.path, event.payload?.to, event.payload?.from);
  }

  if (event.type === "timeline_artifact_emitted") {
    paths.push(event.payload?.path);
  }

  if (effectiveType === "follow_up_completed") {
    const message =
      typeof event.payload?.followUpMessage === "string" ? event.payload.followUpMessage : "";
    paths.push(...extractGeneratedArtifactPathsFromText(message));
  }

  if (effectiveType === "assistant_message") {
    const message = typeof event.payload?.message === "string" ? event.payload.message : "";
    paths.push(...extractGeneratedArtifactPathsFromText(message));
  }

  if (effectiveType === "task_completed") {
    const outputSummary = resolveTaskOutputSummaryFromCompletionEvent(event, eventStream);
    if (outputSummary) {
      paths.push(
        outputSummary.primaryOutputPath,
        ...outputSummary.created,
        ...(outputSummary.modifiedFallback || []),
      );
    }
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || path.trim().length === 0) continue;
    const key = normalizeArtifactCardKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(path);
  }
  return normalized;
}

export function shouldRenderOpenArtifactCardAtEvent(args: {
  path: string;
  event: TaskEvent;
  eventStream?: TaskEvent[];
}): boolean {
  const previewKind = getInlinePreviewKindForGeneratedFile({ path: args.path });
  if (!previewKind || !END_OF_TASK_ARTIFACT_KINDS.has(previewKind)) return true;
  const eventStream = args.eventStream;
  if (!Array.isArray(eventStream) || eventStream.length === 0) return true;

  const targetKey = normalizeArtifactCardKey(args.path);
  let currentIndex = -1;
  let lastReferenceIndex = -1;
  for (let index = 0; index < eventStream.length; index += 1) {
    const candidate = eventStream[index];
    if (candidate === args.event || (candidate.id && candidate.id === args.event.id)) {
      currentIndex = index;
    }
    const referencesTarget = getTaskEventArtifactPaths(candidate, eventStream).some(
      (path) => normalizeArtifactCardKey(path) === targetKey,
    );
    if (referencesTarget) {
      lastReferenceIndex = index;
    }
  }

  return currentIndex >= 0 && currentIndex === lastReferenceIndex;
}

export function collectLatestEndOfTaskArtifactCards(
  eventStream: TaskEvent[],
  limit = 8,
): EndOfTaskArtifactCard[] {
  if (!Array.isArray(eventStream) || eventStream.length === 0 || limit <= 0) return [];

  const byKey = new Map<string, EndOfTaskArtifactCard>();
  eventStream.forEach((event, index) => {
    for (const artifactPath of getTaskEventArtifactPaths(event, eventStream)) {
      const kind = getInlinePreviewKindForGeneratedFile({ path: artifactPath });
      if (!kind || !END_OF_TASK_ARTIFACT_KINDS.has(kind)) continue;
      byKey.set(getArtifactCardDisplayKey(artifactPath, kind), {
        path: artifactPath,
        kind,
        eventId: event.id,
        lastReferenceIndex: index,
        lastReferenceTimestamp: event.timestamp,
      });
    }
  });

  const cards = Array.from(byKey.values()).sort((a, b) => {
    if (a.lastReferenceIndex !== b.lastReferenceIndex) {
      return a.lastReferenceIndex - b.lastReferenceIndex;
    }
    return a.lastReferenceTimestamp - b.lastReferenceTimestamp;
  });
  return cards.slice(Math.max(0, cards.length - limit));
}

export function collectEndOfTaskArtifactCardStacks(
  eventStream: TaskEvent[],
  limit = 8,
): EndOfTaskArtifactStack[] {
  const cards = collectLatestEndOfTaskArtifactCards(eventStream, limit);
  if (cards.length === 0) return [];

  const byAnchorIndex = new Map<number, EndOfTaskArtifactCard[]>();
  for (const card of cards) {
    const existing = byAnchorIndex.get(card.lastReferenceIndex) || [];
    existing.push(card);
    byAnchorIndex.set(card.lastReferenceIndex, existing);
  }

  return Array.from(byAnchorIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([anchorEventIndex, artifacts]) => ({
      anchorEventIndex,
      artifacts,
    }));
}
