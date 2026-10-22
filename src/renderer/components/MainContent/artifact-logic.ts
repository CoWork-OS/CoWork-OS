import type { TaskEvent } from "../../../shared/types";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
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
import {
  IMAGE_FILE_EXT_RE,
  VIDEO_FILE_EXT_RE,
  HTML_FILE_EXT_RE,
  MODEL_FILE_EXT_RE,
} from "./main-content-constants";

export type GeneratedInlinePreviewKind =
  | "image"
  | "video"
  | "html"
  | "spreadsheet"
  | "presentation"
  | "document"
  | "model";

export interface GeneratedImageCard {
  path: string;
  eventId?: string;
  eventIndex: number;
}

export interface GeneratedImageStack {
  anchorEventIndex: number;
  images: GeneratedImageCard[];
}

const GENERATED_IMAGE_COLLAPSED_LIMIT = 5;
const GENERATED_IMAGE_CARD_ESTIMATED_HEIGHT = 300;
const GENERATED_IMAGE_STACK_CHROME_ESTIMATED_HEIGHT = 28;
const GENERATED_IMAGE_SHOW_MORE_ESTIMATED_HEIGHT = 48;

export function getVisibleGeneratedImageCards(
  images: GeneratedImageCard[],
  expanded: boolean,
): { visibleImages: GeneratedImageCard[]; hiddenCount: number } {
  if (expanded || images.length <= GENERATED_IMAGE_COLLAPSED_LIMIT) {
    return { visibleImages: images, hiddenCount: 0 };
  }
  return {
    visibleImages: images.slice(0, GENERATED_IMAGE_COLLAPSED_LIMIT),
    hiddenCount: images.length - GENERATED_IMAGE_COLLAPSED_LIMIT,
  };
}

export function estimateGeneratedImageStackHeight(
  images: GeneratedImageCard[],
  expanded: boolean,
): number {
  const { visibleImages, hiddenCount } = getVisibleGeneratedImageCards(images, expanded);
  return (
    GENERATED_IMAGE_STACK_CHROME_ESTIMATED_HEIGHT +
    visibleImages.length * GENERATED_IMAGE_CARD_ESTIMATED_HEIGHT +
    (hiddenCount > 0 ? GENERATED_IMAGE_SHOW_MORE_ESTIMATED_HEIGHT : 0)
  );
}

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

  if (mimeType.startsWith("model/gltf") || MODEL_FILE_EXT_RE.test(filePath)) {
    return "model";
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

/**
 * Path of an image the task generated (built-in generate_image, or image content saved
 * from an MCP tool), for a file_created event. Browser/computer-use screenshots and
 * other non-generated images return null.
 */
export function getGeneratedImagePathForTaskEvent(event: TaskEvent): string | null {
  if (getEffectiveTaskEventType(event) !== "file_created") return null;
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;
  const filePath = typeof payload.path === "string" ? payload.path.trim() : "";
  if (!filePath) return null;
  const fileType = typeof payload.type === "string" ? payload.type.toLowerCase() : "";
  const isGenerated =
    fileType === "image" ||
    (payload.source === "mcp" && fileType !== "video" && fileType !== "directory");
  if (!isGenerated) return null;
  const kind = getInlinePreviewKindForGeneratedFile({
    path: filePath,
    mimeType: payload.mimeType,
    type: fileType === "image" ? "image" : undefined,
  });
  return kind === "image" ? filePath : null;
}

function getFileBaseNameKey(filePath: string): string {
  let value = filePath.trim().replace(/^<|>$/g, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the raw value when it is not valid percent-encoding.
  }
  const normalized = value.replace(/\\/g, "/").split(/[?#]/)[0] || "";
  return (normalized.split("/").filter(Boolean).pop() || normalized).toLowerCase();
}

// Matches ![alt](path) embeds and [text](path) links (links to images render a thumbnail).
const MARKDOWN_IMAGE_EMBED_RE = /(!?)\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g;

/** Basenames of images an assistant answer already shows inline via ![alt](path) or a link. */
function collectMarkdownEmbeddedImageNames(eventStream: TaskEvent[]): Set<string> {
  const names = new Set<string>();
  for (const event of eventStream) {
    const effectiveType = getEffectiveTaskEventType(event);
    const text =
      effectiveType === "assistant_message" && typeof event.payload?.message === "string"
        ? event.payload.message
        : effectiveType === "task_completed" && typeof event.payload?.resultSummary === "string"
          ? event.payload.resultSummary
          : "";
    if (!text || !text.includes("](")) continue;
    MARKDOWN_IMAGE_EMBED_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKDOWN_IMAGE_EMBED_RE.exec(text))) {
      const isEmbed = match[1] === "!";
      const target = match[2] || "";
      if (/^(?:https?:|data:)/i.test(target)) continue;
      const name = getFileBaseNameKey(target);
      const shownInline = isEmbed
        ? IMAGE_FILE_EXT_RE.test(name)
        : /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
      if (name && shownInline) names.add(name);
    }
  }
  return names;
}

/**
 * Generated images surface as always-visible image cards anchored where they were
 * created, so they stay visible even when the step group holding the event is folded.
 * Images an assistant answer already embeds inline are skipped to avoid showing twice.
 */
export function collectGeneratedImageStacks(
  eventStream: TaskEvent[],
  limit = 8,
): GeneratedImageStack[] {
  if (!Array.isArray(eventStream) || eventStream.length === 0 || limit <= 0) return [];
  const byName = new Map<string, GeneratedImageCard>();
  eventStream.forEach((event, index) => {
    const imagePath = getGeneratedImagePathForTaskEvent(event);
    if (!imagePath) return;
    const name = getFileBaseNameKey(imagePath);
    // A regenerated image moves to its latest creation.
    byName.delete(name);
    byName.set(name, { path: imagePath, eventId: event.id, eventIndex: index });
  });
  if (byName.size === 0) return [];

  const embedded = collectMarkdownEmbeddedImageNames(eventStream);
  const images = Array.from(byName.entries())
    .filter(([name]) => !embedded.has(name))
    .map(([, card]) => card)
    .sort((a, b) => a.eventIndex - b.eventIndex);
  const kept = images.slice(Math.max(0, images.length - limit));

  const byAnchor = new Map<number, GeneratedImageCard[]>();
  for (const image of kept) {
    const existing = byAnchor.get(image.eventIndex) || [];
    existing.push(image);
    byAnchor.set(image.eventIndex, existing);
  }
  return Array.from(byAnchor.entries())
    .sort(([a], [b]) => a - b)
    .map(([anchorEventIndex, stackImages]) => ({ anchorEventIndex, images: stackImages }));
}
