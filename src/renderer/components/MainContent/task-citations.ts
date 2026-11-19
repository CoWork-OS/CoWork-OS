import type { TaskEvent } from "../../../shared/types";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import { extractDomainFromUrl, stripHtmlTags } from "./markdown-normalization";

export type TaskCitation = {
  index: number;
  url: string;
  title: string;
  snippet: string;
  domain: string;
  accessedAt: number;
  sourceTool: string;
  /** The connector a source came from ("Google Calendar"); absent for web pages. */
  sourceLabel?: string;
};

function clean(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? stripHtmlTags(value).trim() : "";
}

/**
 * The task's sources as the answer's [N] badges number them, from its latest citation event.
 * The timeline projection of that event (`timeline_evidence_attached`) carries evidence refs;
 * a legacy `citations_collected` event carries the citations themselves.
 */
export function extractTaskCitations(events: readonly TaskEvent[]): TaskCitation[] {
  let evidenceEvent: TaskEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.type === "timeline_evidence_attached" ||
      getEffectiveTaskEventType(event) === "citations_collected"
    ) {
      evidenceEvent = event;
      break;
    }
  }
  if (!evidenceEvent) return [];
  const payload = (evidenceEvent.payload ?? {}) as Record<string, unknown>;

  const refs = Array.isArray(payload.evidenceRefs)
    ? (payload.evidenceRefs as Array<Record<string, unknown>>)
    : [];
  if (refs.length > 0) {
    return refs.flatMap((ref, position) => {
      const url = typeof ref?.sourceUrlOrPath === "string" ? ref.sourceUrlOrPath : "";
      if (!url) return [];
      const domain = extractDomainFromUrl(url);
      const sourceLabel = clean(ref.sourceLabel);
      const index = Number(ref.citationIndex);
      return [
        {
          index: Number.isSafeInteger(index) && index > 0 ? index : position + 1,
          url,
          title: clean(ref.title) || domain || url,
          snippet: clean(ref.snippet),
          domain,
          accessedAt: typeof ref.capturedAt === "number" ? ref.capturedAt : 0,
          sourceTool: clean(ref.sourceTool) || "timeline_evidence",
          ...(sourceLabel ? { sourceLabel } : {}),
        },
      ];
    });
  }

  const raw = Array.isArray(payload.citations)
    ? (payload.citations as Array<Record<string, unknown>>)
    : [];
  return raw.flatMap((citation, position) => {
    const url = typeof citation?.url === "string" ? citation.url : "";
    if (!url) return [];
    const domain = clean(citation.domain) || extractDomainFromUrl(url);
    const sourceLabel = clean(citation.sourceLabel);
    return [
      {
        index: typeof citation.index === "number" ? citation.index : position + 1,
        url,
        domain,
        title: clean(citation.title) || domain || url,
        snippet: clean(citation.snippet),
        accessedAt: typeof citation.accessedAt === "number" ? citation.accessedAt : 0,
        sourceTool: clean(citation.sourceTool) || clean(citation.source) || "unknown",
        ...(sourceLabel ? { sourceLabel } : {}),
      },
    ];
  });
}
