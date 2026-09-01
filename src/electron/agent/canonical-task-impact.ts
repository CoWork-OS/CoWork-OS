import type { TaskEvent, TaskImpactMetric, TaskMetricKind } from "../../shared/types";

const CANONICAL_OUTCOME_KINDS = new Set<TaskMetricKind>([
  "slides_created",
  "rows_processed",
  "records_updated",
]);

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read only an explicit, typed contract returned by trusted tool code. This is
 * intentionally not a generic property-name or prose parser.
 */
export function extractCanonicalTaskImpactMetrics(event: TaskEvent): TaskImpactMetric[] {
  const payload = asObject(event.payload);
  if (String(payload.tool || "").trim().length === 0) return [];
  const result = asObject(payload.result);
  if (result.success === false || !Array.isArray(result.impactMetrics)) return [];

  const metrics: TaskImpactMetric[] = [];
  for (const rawMetric of result.impactMetrics) {
    const metric = asObject(rawMetric);
    const kind = metric.kind;
    const value = Number(metric.value);
    if (
      typeof kind !== "string" ||
      !CANONICAL_OUTCOME_KINDS.has(kind as TaskMetricKind) ||
      !Number.isFinite(value) ||
      value <= 0
    ) {
      continue;
    }
    metrics.push({
      // Canonical tool counts are per successful outcome. Keeping a unique ID
      // lets replay sum several presentations/spreadsheets without treating a
      // later tool result as a task-wide replacement snapshot.
      id: `${event.taskId}:${kind}:canonical:${event.id}`,
      kind: kind as TaskMetricKind,
      value: Math.floor(value),
      status: "active",
      provenance: "canonical_tool_outcome",
      sourceEventIds: [event.id],
      revision: Math.max(0, Math.floor(event.seq ?? 0)),
      updatedAt: event.timestamp,
    });
  }
  return metrics;
}
