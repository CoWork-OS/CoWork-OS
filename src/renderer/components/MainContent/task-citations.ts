import type { TaskEvent } from "../../../shared/types";
import { readAnswerBibliography } from "../../../shared/answer-citations";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import { extractDomainFromUrl, stripHtmlTags } from "./markdown-normalization";
import { isCompletionSummaryCoveredByAssistantEvent } from "./task-feed-logic";
import { getAssistantOrCompletionText } from "./task-event-presentation";

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

function readLegacyEvidence(payload: Record<string, unknown>): TaskCitation[] {
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

  return readCitationRows(payload.citations);
}

function readCitationRows(value: unknown): TaskCitation[] {
  const raw = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
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

/** Recover the initial run's old terminal snapshot without sharing it with follow-ups. */
export function indexLegacyInitialAnswerCitations(events: readonly TaskEvent[]) {
  const citationsByEventId = new Map<string, TaskCitation[]>();
  let initialTaskId: string | undefined;
  let latestAnswer: TaskEvent | undefined;
  let evidence: TaskCitation[] = [];
  for (const event of events) {
    const type = getEffectiveTaskEventType(event);
    if (type === "task_created") {
      initialTaskId = event.taskId;
      latestAnswer = undefined;
      evidence = [];
    } else if (event.taskId === initialTaskId) {
      if (type === "assistant_message" && event.payload?.internal !== true) {
        latestAnswer = event;
        evidence = [];
      } else if (type === "citations_collected" && !event.payload?.gate) {
        evidence = readLegacyEvidence(event.payload ?? {});
      } else if (type === "task_completed") {
        if (evidence.length) {
          citationsByEventId.set(event.id, evidence);
          if (
            latestAnswer &&
            (getAssistantOrCompletionText(event) === getAssistantOrCompletionText(latestAnswer) ||
              isCompletionSummaryCoveredByAssistantEvent(event, latestAnswer))
          ) {
            citationsByEventId.set(latestAnswer.id, evidence);
          }
        }
        initialTaskId = undefined;
      } else if (
        type === "task_cancelled" ||
        type === "task_failed" ||
        type === "agent_follow_up_started" ||
        type === "follow_up_completed" ||
        type === "follow_up_failed"
      ) {
        initialTaskId = undefined;
      } else if (type === "user_message") {
        latestAnswer = undefined;
        evidence = [];
      }
    }
  }
  return citationsByEventId;
}

export function readSavedAnswerCitations(
  text: string,
  snapshot: unknown,
  legacyEvidence: readonly TaskCitation[] = [],
): TaskCitation[] {
  // Even an empty snapshot is authoritative. It must not inherit citations from another answer.
  if (Array.isArray(snapshot)) return readCitationRows(snapshot);
  if (!/\[\d/.test(text)) return [];
  const ownSources = readAnswerBibliography(text);
  if (ownSources === null) return [];
  if (ownSources.length) {
    return readCitationRows(ownSources).map(
      (source) =>
        legacyEvidence.find((entry) => entry.index === source.index && entry.url === source.url) ??
        source,
    );
  }
  return [...legacyEvidence];
}

export function readTaskAnswerCitations(
  event: TaskEvent,
  legacyEvidence?: readonly TaskCitation[],
) {
  return readSavedAnswerCitations(
    getAssistantOrCompletionText(event),
    event.payload?.answerCitations,
    legacyEvidence,
  );
}
