import type { TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

const CREATION_STEP_PATTERN =
  /\b(create_document|create|created|generate|generated|write|wrote|produce|produced|export|exported|save|saved)\b/i;

const DOCUMENT_PATH_PATTERN =
  /(["'`])([^"'`\n]*?\.(?:docx|pdf|tex))\1|((?:[A-Za-z]:[\\/])?[~./\\\w@%+-]+?\.(?:docx|pdf|tex)\b)/gi;

function normalizeDocumentCandidate(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const withoutLeadingWrapper = trimmed.replace(/^[([{]+/, "");
  const withoutTrailingPunctuation = withoutLeadingWrapper.replace(/[)\]}.;,!?]+$/g, "");
  if (!/\.(docx|pdf|tex)$/i.test(withoutTrailingPunctuation)) {
    return null;
  }
  return withoutTrailingPunctuation;
}

export function extractDocumentPathFromText(text: string): string | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  for (const match of text.matchAll(DOCUMENT_PATH_PATTERN)) {
    const rawCandidate = match[2] ?? match[3];
    if (!rawCandidate) continue;
    const normalized = normalizeDocumentCandidate(rawCandidate);
    if (normalized) return normalized;
  }

  return null;
}

export function isCreationStepText(text: string): boolean {
  if (typeof text !== "string" || text.trim().length === 0) return false;
  return CREATION_STEP_PATTERN.test(text);
}

export function getStepCompletionPreviewPath(event: TaskEvent): string | null {
  if (getEffectiveTaskEventType(event) !== "step_completed") return null;

  const stepDescription =
    typeof event.payload?.step?.description === "string" ? event.payload.step.description : "";
  const message = typeof event.payload?.message === "string" ? event.payload.message : "";
  const combinedText = `${stepDescription}\n${message}`.trim();

  if (!combinedText || !isCreationStepText(combinedText)) {
    return null;
  }

  return extractDocumentPathFromText(combinedText);
}
