import type { TaskEvent } from "../../shared/types";

type Any = Record<string, unknown>;

const TRIVIAL_PHRASES = new Set([
  "done.",
  "done",
  "task complete.",
  "task complete",
  "task completed.",
  "task completed",
  "task completed successfully.",
  "task completed successfully",
  "complete.",
  "complete",
  "completed.",
  "completed",
  "all set.",
  "all set",
  "finished.",
  "finished",
]);

const TIMELINE_NOISE_PREFIXES = [
  "executing step ",
  "completed step ",
  "tool batch:",
  "taking care of:",
  "applying fixes",
  "working on your request",
  "attached ",
  "artifact ready:",
  "output ready:",
];

const FAILURE_HINT_RE =
  /\b(not ready yet|does not pass|what(?:'|’)s missing|problems to fix|needs to change to complete|completion blocked|task failed|step failed|missing_required_workspace_artifact)\b/i;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isFailureLike(text: string): boolean {
  return FAILURE_HINT_RE.test(text);
}

function isNoiseMessage(text: string): boolean {
  const lower = text.toLowerCase();
  if (TRIVIAL_PHRASES.has(lower)) return true;
  return TIMELINE_NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function pushCandidate(
  text: string,
  bucket: {
    bestNonFailure: string;
    lastNonFailure: string;
    bestFailure: string;
    lastFailure: string;
  },
): void {
  if (!text) return;
  if (isFailureLike(text)) {
    if (!bucket.lastFailure) bucket.lastFailure = text;
    if (text.length > bucket.bestFailure.length) bucket.bestFailure = text;
    return;
  }

  if (!bucket.lastNonFailure) bucket.lastNonFailure = text;
  if (text.length > bucket.bestNonFailure.length) bucket.bestNonFailure = text;
}

function pickBestCandidate(bucket: {
  bestNonFailure: string;
  lastNonFailure: string;
  bestFailure: string;
  lastFailure: string;
}): string {
  return (
    bucket.bestNonFailure || bucket.lastNonFailure || bucket.bestFailure || bucket.lastFailure || ""
  );
}

/**
 * Resolve the best user-facing task output for channel delivery.
 *
 * This supports both legacy assistant_message events and newer timeline_* events.
 * It also prefers rich artifact previews over failure-like verification blurbs when available.
 */
export function resolveTaskResultText(opts: {
  summary?: string | null;
  semanticSummary?: string | null;
  verificationVerdict?: string | null;
  verificationReport?: string | null;
  events?: TaskEvent[] | null;
}): string | undefined {
  const summary = normalizeText(opts.summary);
  const semanticSummary = normalizeText(opts.semanticSummary);
  const verificationVerdict = normalizeText(opts.verificationVerdict);
  const verificationReport = normalizeText(opts.verificationReport);
  const events = Array.isArray(opts.events) ? opts.events : [];

  const candidateBucket = {
    bestNonFailure: "",
    lastNonFailure: "",
    bestFailure: "",
    lastFailure: "",
  };
  let bestInternalCandidate = "";
  let completionEventSummary = "";
  let bestArtifactPreview = "";
  const explicitCompletionSummary = [summary, semanticSummary].filter((value) => value.length > 0).join("\n\n");
  const explicitVerificationSummary =
    verificationVerdict || verificationReport
      ? [
          verificationVerdict ? `Verification: ${verificationVerdict}` : "",
          verificationReport || "",
        ]
          .filter((value) => value.length > 0)
          .join("\n")
      : "";

  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    const payload = ((evt?.payload as Any) || {}) as Any;

    if (evt.type === "task_completed") {
      const rs = [normalizeText(payload.resultSummary), normalizeText(payload.semanticSummary)]
        .filter((value) => value.length > 0)
        .join("\n\n");
      const verdict = normalizeText(payload.verificationVerdict);
      const report = normalizeText(payload.verificationReport);
      const composed = [rs, verdict ? `Verification: ${verdict}` : "", report || ""]
        .filter((value) => value.length > 0)
        .join("\n\n");
      if (composed.length > completionEventSummary.length) {
        completionEventSummary = composed;
      }
      continue;
    }

    if (evt.type === "assistant_message") {
      const text = normalizeText(payload.message) || normalizeText(payload.content);
      if (!text || isNoiseMessage(text)) continue;

      if (payload.internal === true) {
        if (text.length > 50 && text.length > bestInternalCandidate.length) {
          bestInternalCandidate = text;
        }
        continue;
      }

      pushCandidate(text, candidateBucket);
      continue;
    }

    if (
      evt.type === "timeline_step_updated" ||
      evt.type === "timeline_step_finished" ||
      evt.type === "timeline_group_finished"
    ) {
      const actor = normalizeText(payload.actor) || normalizeText(evt.actor);
      if (actor && actor !== "agent") continue;

      const text = normalizeText(payload.message) || normalizeText(payload.content);
      if (!text || isNoiseMessage(text)) continue;
      pushCandidate(text, candidateBucket);
      continue;
    }

    if (evt.type === "timeline_artifact_emitted") {
      const preview = normalizeText(payload.contentPreview);
      if (!preview || payload.previewTruncated === true || preview.length < 120) continue;

      const artifactPath = normalizeText(payload.path).toLowerCase();
      const isTextLike =
        artifactPath.endsWith(".md") ||
        artifactPath.endsWith(".markdown") ||
        artifactPath.endsWith(".txt");
      if (!isTextLike && preview.length < 600) continue;

      if (preview.length > bestArtifactPreview.length) {
        bestArtifactPreview = preview;
      }
    }
  }

  let eventResult =
    pickBestCandidate(candidateBucket) ||
    bestInternalCandidate ||
    completionEventSummary ||
    explicitCompletionSummary ||
    explicitVerificationSummary;

  if (bestArtifactPreview) {
    if (
      !eventResult ||
      isFailureLike(eventResult) ||
      bestArtifactPreview.length > eventResult.length + 200
    ) {
      eventResult = bestArtifactPreview;
    }
  }

  if (summary && eventResult) {
    const completionSummary = [summary, semanticSummary].filter((value) => value.length > 0).join("\n\n");
    if (isFailureLike(summary) && !isFailureLike(eventResult) && eventResult.length >= 200) {
      return eventResult;
    }
    return eventResult.length > completionSummary.length ? eventResult : completionSummary;
  }

  return eventResult || explicitCompletionSummary || explicitVerificationSummary || summary || undefined;
}
