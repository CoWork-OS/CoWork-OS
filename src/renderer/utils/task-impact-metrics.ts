import type {
  TaskEvent,
  TaskImpactMetric,
  TaskMetricKind,
  TaskOutputSummary,
  TaskStatusMetricSlot,
} from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

interface MetricRegistryEntry {
  compactPriority: number;
  responsivePriority: number;
  format: (value: number) => string;
}

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

const METRIC_REGISTRY: Record<TaskMetricKind, MetricRegistryEntry> = {
  records_updated: {
    compactPriority: 110,
    responsivePriority: 110,
    format: (value) => `${integer.format(value)} record${value === 1 ? "" : "s"} updated`,
  },
  slides_created: {
    compactPriority: 108,
    responsivePriority: 108,
    format: (value) => `${integer.format(value)} slide${value === 1 ? "" : "s"}`,
  },
  rows_processed: {
    compactPriority: 106,
    responsivePriority: 106,
    format: (value) => `${integer.format(value)} row${value === 1 ? "" : "s"}`,
  },
  sources_collected: {
    compactPriority: 104,
    responsivePriority: 104,
    format: (value) => `${integer.format(value)} source${value === 1 ? "" : "s"}`,
  },
  citations_used: {
    compactPriority: 102,
    responsivePriority: 102,
    format: (value) => `${integer.format(value)} cited`,
  },
  artifacts_created: {
    compactPriority: 100,
    responsivePriority: 100,
    format: (value) => `${integer.format(value)} artifact${value === 1 ? "" : "s"}`,
  },
  files_changed: {
    compactPriority: 98,
    responsivePriority: 98,
    format: (value) => `${integer.format(value)} file${value === 1 ? "" : "s"}`,
  },
  lines_added: {
    compactPriority: 97,
    responsivePriority: 97,
    format: (value) => `+${integer.format(value)}`,
  },
  lines_removed: {
    compactPriority: 96,
    responsivePriority: 97,
    format: (value) => `−${integer.format(value)}`,
  },
  checks_passed: {
    compactPriority: 94,
    responsivePriority: 94,
    format: (value) => `${integer.format(value)} check${value === 1 ? "" : "s"} passed`,
  },
  agents_active: {
    compactPriority: 92,
    responsivePriority: 92,
    format: (value) => `${integer.format(value)} agent${value === 1 ? "" : "s"} active`,
  },
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isTaskMetricKind(value: unknown): value is TaskMetricKind {
  return typeof value === "string" && value in METRIC_REGISTRY;
}

function normalizeMetric(value: unknown, fallbackEvent: TaskEvent): TaskImpactMetric | null {
  const metric = asObject(value);
  if (!isTaskMetricKind(metric.kind)) return null;
  const count = Number(metric.value);
  if (!Number.isFinite(count) || count < 0) return null;
  const provenance = metric.provenance;
  if (
    provenance !== "plan_projection" &&
    provenance !== "canonical_tool_outcome" &&
    provenance !== "timeline_evidence" &&
    provenance !== "task_mutation_ledger"
  ) {
    return null;
  }
  const sourceEventIds = Array.isArray(metric.sourceEventIds)
    ? metric.sourceEventIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [fallbackEvent.id];
  return {
    id:
      typeof metric.id === "string" && metric.id.trim().length > 0
        ? metric.id.trim()
        : `${fallbackEvent.taskId}:${metric.kind}`,
    kind: metric.kind,
    value: Math.floor(count),
    status: metric.status === "final" ? "final" : "active",
    provenance,
    sourceEventIds: sourceEventIds.length > 0 ? sourceEventIds : [fallbackEvent.id],
    revision:
      typeof metric.revision === "number" && Number.isFinite(metric.revision)
        ? Math.max(0, Math.floor(metric.revision))
        : Math.max(0, Math.floor(fallbackEvent.seq ?? 0)),
    updatedAt:
      typeof metric.updatedAt === "number" && Number.isFinite(metric.updatedAt)
        ? metric.updatedAt
        : fallbackEvent.timestamp,
  };
}

function eventOrder(event: TaskEvent, index: number): number {
  return typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : index;
}

function metricFromCount(args: {
  taskId: string;
  kind: TaskMetricKind;
  value: number;
  sourceEventIds: string[];
  updatedAt: number;
  status: "active" | "final";
  provenance?: TaskImpactMetric["provenance"];
}): TaskImpactMetric | null {
  if (!Number.isFinite(args.value) || args.value <= 0 || args.sourceEventIds.length === 0) {
    return null;
  }
  return {
    id: `${args.taskId}:${args.kind}:canonical`,
    kind: args.kind,
    value: Math.floor(args.value),
    status: args.status,
    provenance: args.provenance ?? "timeline_evidence",
    sourceEventIds: args.sourceEventIds,
    revision: args.sourceEventIds.length,
    updatedAt: args.updatedAt,
  };
}

/**
 * Fold persisted impact snapshots and a deliberately small set of canonical,
 * typed events. This function never inspects assistant prose or tool arguments.
 */
export function deriveTaskImpactMetrics(args: {
  events: TaskEvent[];
  outputSummary?: TaskOutputSummary | null;
  taskStatus?: string;
}): TaskImpactMetric[] {
  const persisted = new Map<string, { metric: TaskImpactMetric; order: number }>();
  const citationUrls = new Set<string>();
  const citationEventIds = new Set<string>();
  const artifactPaths = new Set<string>();
  const artifactEventIds = new Set<string>();
  const verificationEventIds = new Set<string>();
  let activeAgents = 0;
  const agentEventIds = new Set<string>();
  let latestAt = 0;
  let taskId = "task";

  args.events.forEach((event, index) => {
    taskId = event.taskId || taskId;
    latestAt = Math.max(latestAt, event.timestamp || 0);
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType === "task_impact_updated" || event.type === "task_impact_updated") {
      const payload = asObject(event.payload);
      const replaceProvenance = payload.replaceProvenance;
      if (
        replaceProvenance === "plan_projection" ||
        replaceProvenance === "canonical_tool_outcome" ||
        replaceProvenance === "timeline_evidence" ||
        replaceProvenance === "task_mutation_ledger"
      ) {
        for (const [id, entry] of persisted) {
          if (entry.metric.provenance === replaceProvenance) persisted.delete(id);
        }
      }
      const rawMetrics = Array.isArray(payload.metrics)
        ? payload.metrics
        : payload.metric
          ? [payload.metric]
          : [];
      for (const rawMetric of rawMetrics) {
        const metric = normalizeMetric(rawMetric, event);
        if (!metric) continue;
        const order = eventOrder(event, index);
        const previous = persisted.get(metric.id);
        if (
          !previous ||
          metric.revision > previous.metric.revision ||
          (metric.revision === previous.metric.revision && order >= previous.order)
        ) {
          persisted.set(metric.id, { metric, order });
        }
      }
      return;
    }

    if (effectiveType === "citations_collected") {
      const payload = asObject(event.payload);
      const citations = Array.isArray(payload.citations) ? (payload.citations as unknown[]) : [];
      const evidenceRefs = Array.isArray(payload.evidenceRefs)
        ? (payload.evidenceRefs as unknown[])
        : [];
      let added = false;
      for (const citation of [...citations, ...evidenceRefs]) {
        const entry = asObject(citation);
        const url =
          typeof entry.url === "string"
            ? entry.url.trim()
            : typeof entry.source === "string"
              ? entry.source.trim()
              : typeof entry.sourceUrlOrPath === "string" && entry.sourceType === "url"
                ? entry.sourceUrlOrPath.trim()
                : "";
        if (!url) continue;
        citationUrls.add(url);
        added = true;
      }
      if (added) citationEventIds.add(event.id);
    }

    if (effectiveType === "artifact_created") {
      const path = asObject(event.payload).path;
      if (typeof path === "string" && path.trim()) {
        artifactPaths.add(path.trim());
        artifactEventIds.add(event.id);
      }
    }

    if (effectiveType === "verification_passed") {
      verificationEventIds.add(event.id);
    }

    if (effectiveType === "agent_spawned") {
      activeAgents += 1;
      agentEventIds.add(event.id);
    } else if (effectiveType === "agent_completed" || effectiveType === "agent_failed") {
      activeAgents = Math.max(0, activeAgents - 1);
      agentEventIds.add(event.id);
    }
  });

  const isFinal =
    args.taskStatus === "completed" ||
    args.taskStatus === "failed" ||
    args.taskStatus === "cancelled";
  const canonical: Array<TaskImpactMetric | null> = [
    metricFromCount({
      taskId,
      kind: "sources_collected",
      value: citationUrls.size,
      sourceEventIds: [...citationEventIds],
      updatedAt: latestAt,
      status: isFinal ? "final" : "active",
    }),
    metricFromCount({
      taskId,
      kind: "artifacts_created",
      value: Math.max(artifactPaths.size, args.outputSummary?.created.length ?? 0),
      sourceEventIds:
        artifactEventIds.size > 0
          ? [...artifactEventIds]
          : args.outputSummary?.created.length
            ? [`${taskId}:output-summary`]
            : [],
      updatedAt: latestAt,
      status: isFinal ? "final" : "active",
    }),
    metricFromCount({
      taskId,
      kind: "checks_passed",
      value: verificationEventIds.size,
      sourceEventIds: [...verificationEventIds],
      updatedAt: latestAt,
      status: isFinal ? "final" : "active",
    }),
    metricFromCount({
      taskId,
      kind: "agents_active",
      value: activeAgents,
      sourceEventIds: [...agentEventIds],
      updatedAt: latestAt,
      status: "active",
      provenance: "canonical_tool_outcome",
    }),
  ];

  const byKind = new Map<TaskMetricKind, TaskImpactMetric>();
  for (const { metric } of persisted.values()) {
    const previous = byKind.get(metric.kind);
    if (
      metric.provenance === "canonical_tool_outcome" &&
      previous?.provenance === metric.provenance
    ) {
      byKind.set(metric.kind, {
        ...metric,
        id: `${taskId}:${metric.kind}:canonical-total`,
        value: previous.value + metric.value,
        sourceEventIds: [...new Set([...previous.sourceEventIds, ...metric.sourceEventIds])],
        revision: Math.max(previous.revision, metric.revision),
        updatedAt: Math.max(previous.updatedAt, metric.updatedAt),
        status: previous.status === "final" && metric.status === "final" ? "final" : "active",
      });
      continue;
    }
    if (
      !previous ||
      metric.revision > previous.revision ||
      (metric.revision === previous.revision && metric.updatedAt >= previous.updatedAt)
    ) {
      byKind.set(metric.kind, metric);
    }
  }
  for (const metric of canonical) {
    if (metric && !byKind.has(metric.kind)) byKind.set(metric.kind, metric);
  }
  return [...byKind.values()]
    .map((metric): TaskImpactMetric => (isFinal ? { ...metric, status: "final" as const } : metric))
    .sort((a, b) => {
      const priority =
        METRIC_REGISTRY[b.kind].compactPriority - METRIC_REGISTRY[a.kind].compactPriority;
      return priority || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
    });
}

export function selectTaskStatusMetricSlots(
  metrics: TaskImpactMetric[],
  limit = 2,
): TaskStatusMetricSlot[] {
  const eligible = metrics.filter(
    (metric) =>
      Number.isFinite(metric.value) &&
      metric.value > 0 &&
      metric.sourceEventIds.length > 0 &&
      metric.kind in METRIC_REGISTRY,
  );
  const hasDomainSpecificMetric = eligible.some((metric) =>
    [
      "records_updated",
      "slides_created",
      "rows_processed",
      "sources_collected",
      "citations_used",
    ].includes(metric.kind),
  );
  const candidates =
    !hasDomainSpecificMetric && eligible.some((metric) => metric.kind === "files_changed")
      ? [...eligible].sort((a, b) => {
          const codingRank = (kind: TaskMetricKind) =>
            kind === "files_changed"
              ? 3
              : kind === "lines_added" || kind === "lines_removed"
                ? 2
                : 1;
          return codingRank(b.kind) - codingRank(a.kind);
        })
      : eligible;
  const slots: TaskStatusMetricSlot[] = [];
  const consumed = new Set<TaskMetricKind>();
  const added = eligible.find((metric) => metric.kind === "lines_added");
  const removed = eligible.find((metric) => metric.kind === "lines_removed");

  for (const metric of candidates) {
    if (slots.length >= limit || consumed.has(metric.kind)) continue;
    if (metric.kind === "lines_added" || metric.kind === "lines_removed") {
      const pair = [added, removed].filter((item): item is TaskImpactMetric => Boolean(item));
      pair.forEach((item) => consumed.add(item.kind));
      if (pair.length === 0) continue;
      slots.push({
        id: "line-impact",
        label: pair.map((item) => METRIC_REGISTRY[item.kind].format(item.value)).join(" "),
        metricIds: pair.map((item) => item.id),
        responsivePriority: Math.max(
          ...pair.map((item) => METRIC_REGISTRY[item.kind].responsivePriority),
        ),
        status: pair.every((item) => item.status === "final") ? "final" : "active",
      });
      continue;
    }
    consumed.add(metric.kind);
    slots.push({
      id: metric.kind,
      label: METRIC_REGISTRY[metric.kind].format(metric.value),
      metricIds: [metric.id],
      responsivePriority: METRIC_REGISTRY[metric.kind].responsivePriority,
      status: metric.status === "final" ? "final" : "active",
    });
  }

  return slots
    .sort((a, b) => b.responsivePriority - a.responsivePriority)
    .slice(0, Math.max(0, limit));
}

export function formatTaskImpactMetric(metric: TaskImpactMetric): string {
  return METRIC_REGISTRY[metric.kind].format(metric.value);
}
