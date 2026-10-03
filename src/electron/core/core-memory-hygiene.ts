import type { CoreMemoryCandidate, CoreTrace, CoreTraceEvent } from "../../shared/types";

/**
 * Shared rules that keep the core learning loop from turning routine runtime telemetry into
 * memories, failures, or learnings (memory audit DATA-3 and LOOP-10).
 */

/** Event types emitted by healthy pulses and reflection runs that found nothing to do. */
const ROUTINE_EVENT_TYPES = new Set([
  "heartbeat.deferred",
  "heartbeat.idle",
  "heartbeat.gated",
  "heartbeat.no_workspace",
  "subconscious.no_evidence",
]);

/** Event types that mean the run did real work or failed, so it is never routine. */
const SUBSTANTIVE_EVENT_TYPES = new Set([
  "heartbeat.dispatch_started",
  "heartbeat.dispatch_completed",
  "heartbeat.error",
  "subconscious.dispatch_started",
  "subconscious.dispatch_completed",
  "subconscious.error",
]);

/** Trace summaries written by routine outcomes, for traces that carry no events. */
const ROUTINE_SUMMARY_PATTERNS: RegExp[] = [
  /^outside active hours\.?$/i,
  /^dispatch cooldown active\.?$/i,
  /^dispatch already in flight\.?$/i,
  /^daily dispatch budget exhausted\.?$/i,
  /^no actionable heartbeat state\.?$/i,
  /^foreground work active; deferred\b/i,
  /^no fresh evidence was worth acting on\b/i,
  /^no workspace available for heartbeat dispatch\.?$/i,
];

/**
 * True when a trace records a healthy "nothing to do" outcome: an idle, deferred, gated or
 * cooldown pulse, or a reflection run without fresh evidence. Failed traces and traces with
 * error or dispatch events are never routine.
 */
export function isRoutineCoreOutcome(
  trace: Pick<CoreTrace, "status" | "summary" | "error">,
  events: Array<Pick<CoreTraceEvent, "phase" | "eventType">>,
): boolean {
  if (trace.status === "failed" || trace.error) return false;
  if (
    events.some(
      (event) =>
        event.phase === "error" ||
        event.phase === "dispatch" ||
        SUBSTANTIVE_EVENT_TYPES.has(event.eventType),
    )
  ) {
    return false;
  }
  if (events.some((event) => ROUTINE_EVENT_TYPES.has(event.eventType))) return true;
  const summary = (trace.summary || "").trim();
  return ROUTINE_SUMMARY_PATTERNS.some((pattern) => pattern.test(summary));
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Removes the legacy `[core-trace:<id>]` and `[scope:<kind>:<ref>]` content prefixes. */
export function stripCoreMemoryPrefixes(text: string): string {
  return text.replace(/^\s*(?:\[(?:core-trace|scope):[^\]]*\]\s*)+/i, "");
}

/**
 * Normalizes a candidate summary for duplicate detection: drops legacy prefixes, ids and
 * numbers, punctuation and case, so the same observation from different runs compares equal.
 */
export function normalizeCandidateSummary(summary: string): string {
  return stripCoreMemoryPrefixes(summary)
    .toLowerCase()
    .replace(UUID_PATTERN, "#")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** Duplicate key for a candidate: owner profile, scope, type and normalized summary. */
export function coreCandidateFingerprint(
  candidate: Pick<
    CoreMemoryCandidate,
    "profileId" | "scopeKind" | "scopeRef" | "candidateType" | "summary"
  >,
): string {
  return [
    candidate.profileId,
    candidate.scopeKind,
    candidate.scopeRef,
    candidate.candidateType,
    normalizeCandidateSummary(candidate.summary),
  ].join("::");
}
