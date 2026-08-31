import type { UiTimelineEvent } from "../../shared/timeline-events";
import type {
  TaskEvent,
  TaskTraceBadge,
  TaskTraceInspectorField,
  TaskTraceRow,
  TaskTraceRowActor,
  TaskTraceTab,
} from "../../shared/types";
import { normalizeMarkdownForCollab } from "./markdown-inline-lists";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string, length = 240): string {
  const normalized = value.trim();
  if (normalized.length <= length) return normalized;
  return `${normalized.slice(0, length - 1)}…`;
}

function humanizeToken(token: string): string {
  return token.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function getEffectiveEventType(event: TaskEvent): string {
  return typeof event.legacyType === "string" && event.legacyType.trim().length > 0
    ? event.legacyType
    : event.type;
}

function inferRowActorFromEvent(event: TaskEvent): TaskTraceRowActor {
  const effectiveType = getEffectiveEventType(event);
  if (effectiveType === "user_message") return "user";
  if (effectiveType === "assistant_message" || effectiveType === "agent_thought") return "agent";
  if (effectiveType === "llm_usage") return "model";
  if (
    effectiveType === "task_completed" ||
    effectiveType === "artifact_created" ||
    effectiveType === "timeline_artifact_emitted"
  ) {
    return "result";
  }
  if (
    effectiveType === "tool_call" ||
    effectiveType === "tool_result" ||
    effectiveType === "tool_error" ||
    effectiveType === "tool_warning" ||
    effectiveType === "tool_blocked" ||
    effectiveType === "timeline_command_output"
  ) {
    return effectiveType === "tool_result" ? "result" : "tool";
  }
  if (event.actor === "user" || event.actor === "agent" || event.actor === "tool") {
    return event.actor;
  }
  if (event.actor === "subagent") return "agent";
  return "system";
}

function toRowLabel(actor: TaskTraceRowActor): string {
  switch (actor) {
    case "user":
      return "User";
    case "agent":
      return "Agent";
    case "tool":
      return "Tool";
    case "model":
      return "Model";
    case "result":
      return "Result";
    default:
      return "System";
  }
}

function extractEventMessage(payload: Record<string, unknown>): string {
  const directCandidates = [
    payload.message,
    payload.content,
    payload.summary,
    payload.reason,
    payload.error,
  ];
  for (const candidate of directCandidates) {
    const text = normalizeText(candidate);
    if (text) return text;
  }

  const result = asObject(payload.result);
  for (const candidate of [result.message, result.summary, result.error]) {
    const text = normalizeText(candidate);
    if (text) return text;
  }

  return "";
}

function extractDurationMs(payload: Record<string, unknown>): number | undefined {
  const direct = payload.durationMs;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const elapsed = payload.elapsedMs;
  if (typeof elapsed === "number" && Number.isFinite(elapsed)) return elapsed;
  const resultDuration = asObject(payload.result).durationMs;
  if (typeof resultDuration === "number" && Number.isFinite(resultDuration)) return resultDuration;
  return undefined;
}

function toStatusTone(status: string | undefined): TaskTraceBadge["tone"] {
  switch (status) {
    case "failed":
    case "blocked":
    case "cancelled":
    case "error":
      return "error";
    case "completed":
    case "success":
      return "success";
    case "in_progress":
    case "running":
      return "active";
    case "skipped":
      return "warning";
    default:
      return "neutral";
  }
}

function formatBadge(label: string, tone?: TaskTraceBadge["tone"]): TaskTraceBadge {
  return { label, ...(tone ? { tone } : {}) };
}

function buildInspectorFields(
  entries: Array<[string, string | undefined]>,
): TaskTraceInspectorField[] {
  return entries
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
    )
    .map(([label, value]) => ({ label, value }));
}

function getSemanticEventDuration(event: UiTimelineEvent): number | undefined {
  return "durationMs" in event && typeof event.durationMs === "number"
    ? event.durationMs
    : undefined;
}

function getSemanticEventActionKind(event: UiTimelineEvent): string | undefined {
  return event.kind === "summary" ? event.actionKind : undefined;
}

export function normalizeTaskTraceMarkdownDisplay(text: string): string {
  let result = normalizeMarkdownForCollab(text);
  result = result.replace(/`(\*\*\/([^\s`]+))`/g, "`/$2`");
  result = result.replace(/\s\*\*(?=(?:$|[\s.,;:!?]))/g, " all files");
  return result;
}

function inferTranscriptRowActor(
  event: UiTimelineEvent,
  matchedRawEvents: TaskEvent[],
): TaskTraceRowActor {
  const rawTypes = matchedRawEvents.map((rawEvent) => getEffectiveEventType(rawEvent));

  if (rawTypes.some((type) => type === "user_message")) return "user";
  if (rawTypes.some((type) => type === "llm_usage")) return "model";
  if (
    rawTypes.some(
      (type) =>
        type === "task_completed" ||
        type === "artifact_created" ||
        type === "timeline_artifact_emitted",
    )
  ) {
    return "result";
  }
  if (
    rawTypes.some(
      (type) =>
        type === "tool_call" ||
        type === "tool_result" ||
        type === "tool_error" ||
        type === "tool_warning" ||
        type === "tool_blocked" ||
        type === "timeline_command_output",
    )
  ) {
    return rawTypes.includes("tool_result") ? "result" : "tool";
  }
  if (rawTypes.some((type) => type === "assistant_message" || type === "agent_thought")) {
    return "agent";
  }

  if (event.kind === "approval") return "tool";
  const actionKind = getSemanticEventActionKind(event);
  if (actionKind === "task.complete" || actionKind === "artifact.create") return "result";
  if (actionKind === "step.update") return "agent";
  return "tool";
}

export function buildTaskTraceTranscriptRows(
  semanticTimeline: UiTimelineEvent[],
  rawEvents: TaskEvent[],
): TaskTraceRow[] {
  if (semanticTimeline.length === 0 && rawEvents.length > 0) {
    return buildTaskTraceDebugRows(rawEvents).map((row) => ({
      ...row,
      id: row.id.replace(/^debug:/, "transcript:fallback:"),
      tab: "transcript",
    }));
  }

  const allEventsById = new Map(rawEvents.map((event) => [event.id, event]));

  return semanticTimeline.map((event) => {
    const matchedRawEvents = event.rawEventIds
      .map((id) => allEventsById.get(id))
      .filter((item): item is TaskEvent => Boolean(item));
    const bodyCandidate = matchedRawEvents
      .map((rawEvent) => extractEventMessage(asObject(rawEvent.payload)))
      .find((text) => text && text !== event.summary);
    const status = event.status;
    const durationMs = getSemanticEventDuration(event);
    const actionKind = getSemanticEventActionKind(event);
    const actor = inferTranscriptRowActor(event, matchedRawEvents);
    const badges: TaskTraceBadge[] = [
      formatBadge(humanizeToken(event.phase)),
      formatBadge(humanizeToken(status), toStatusTone(status)),
      ...(typeof durationMs === "number"
        ? [formatBadge(`${Math.max(1, Math.round(durationMs / 1000))}s`)]
        : []),
      ...(event.evidence.length > 0 ? [formatBadge(`${event.evidence.length} evidence`)] : []),
      ...(event.rawEventIds.length > 0 ? [formatBadge(`${event.rawEventIds.length} raw`)] : []),
    ];

    return {
      id: `transcript:${event.id}`,
      tab: "transcript",
      actor,
      label: toRowLabel(actor),
      title: event.summary,
      ...(bodyCandidate ? { body: truncate(bodyCandidate, 320) } : {}),
      timestamp: Date.parse(event.startedAt) || matchedRawEvents[0]?.timestamp || Date.now(),
      ...(typeof durationMs === "number" ? { durationMs } : {}),
      status,
      badges,
      rawEventIds: event.rawEventIds,
      inspector: {
        title: event.summary,
        subtitle: `${humanizeToken(event.kind)} · ${humanizeToken(event.phase)}`,
        ...(bodyCandidate ? { content: bodyCandidate } : {}),
        rawEventIds: event.rawEventIds,
        fields: buildInspectorFields([
          ["Phase", humanizeToken(event.phase)],
          ["Status", humanizeToken(status)],
          ["Action", actionKind ? humanizeToken(actionKind) : undefined],
          ["Duration", typeof durationMs === "number" ? `${durationMs}ms` : undefined],
          [
            "Evidence",
            event.evidence.length > 0
              ? event.evidence
                  .map((item) => {
                    if (item.type === "file") return `File: ${item.path}`;
                    if (item.type === "command") return `Command: ${item.command}`;
                    if (item.type === "query") return `Query: ${item.query}`;
                    if (item.type === "artifact") return `Artifact: ${item.path}`;
                    if (item.type === "approval") return `Approval: ${item.label}`;
                    if (item.type === "url") return `URL: ${item.url}`;
                    return `Runtime log: ${item.message}`;
                  })
                  .join("\n")
              : undefined,
          ],
        ]),
        json: matchedRawEvents.map((item) => ({
          id: item.id,
          type: item.type,
          legacyType: item.legacyType,
          timestamp: item.timestamp,
          status: item.status,
          seq: item.seq,
          stepId: item.stepId,
          groupId: item.groupId,
          actor: item.actor,
          payload: item.payload,
        })),
      },
    };
  });
}

function buildDebugRowTitle(event: TaskEvent, payload: Record<string, unknown>): string {
  const effectiveType = getEffectiveEventType(event);
  if (effectiveType === "user_message" || effectiveType === "assistant_message") {
    const message = extractEventMessage(payload);
    return message ? truncate(message, 140) : humanizeToken(effectiveType);
  }

  if (
    effectiveType === "tool_call" ||
    effectiveType === "tool_result" ||
    effectiveType === "tool_error" ||
    effectiveType === "tool_warning" ||
    effectiveType === "tool_blocked"
  ) {
    const toolName = normalizeText(payload.tool) || normalizeText(payload.toolName) || "tool";
    return humanizeToken(toolName);
  }

  if (effectiveType === "llm_usage") {
    const provider = normalizeText(payload.providerType) || "model";
    const model = normalizeText(payload.modelId) || normalizeText(payload.modelKey);
    return truncate(`${provider}${model ? ` / ${model}` : ""}`, 140);
  }

  return humanizeToken(effectiveType);
}

function buildDebugRowBody(payload: Record<string, unknown>): string | undefined {
  const message = extractEventMessage(payload);
  if (message) return truncate(message, 260);
  try {
    const json = JSON.stringify(payload);
    return json.length > 0 ? truncate(json, 260) : undefined;
  } catch {
    return undefined;
  }
}

export function buildTaskTraceDebugRows(rawEvents: TaskEvent[]): TaskTraceRow[] {
  return rawEvents.map((event) => {
    const payload = asObject(event.payload);
    const effectiveType = getEffectiveEventType(event);
    const actor = inferRowActorFromEvent(event);
    const durationMs = extractDurationMs(payload);
    const status = normalizeText(event.status) || normalizeText(payload.status) || undefined;
    const body = buildDebugRowBody(payload);
    const title = buildDebugRowTitle(event, payload);
    const badges: TaskTraceBadge[] = [
      formatBadge(humanizeToken(effectiveType)),
      ...(status ? [formatBadge(humanizeToken(status), toStatusTone(status))] : []),
      ...(typeof event.seq === "number" ? [formatBadge(`seq ${event.seq}`)] : []),
      ...(typeof durationMs === "number"
        ? [formatBadge(`${Math.max(1, Math.round(durationMs / 1000))}s`)]
        : []),
    ];

    const delta = asObject(payload.delta);
    if (effectiveType === "llm_usage") {
      if (typeof delta.inputTokens === "number")
        badges.push(formatBadge(`in ${delta.inputTokens}`));
      if (typeof delta.outputTokens === "number")
        badges.push(formatBadge(`out ${delta.outputTokens}`));
    }

    return {
      id: `debug:${event.id}`,
      tab: "debug",
      actor,
      label: toRowLabel(actor),
      title,
      ...(body ? { body } : {}),
      timestamp: event.timestamp,
      ...(typeof durationMs === "number" ? { durationMs } : {}),
      status,
      badges,
      rawEventIds: [event.id],
      inspector: {
        title,
        subtitle: `${humanizeToken(effectiveType)} · ${toRowLabel(actor)}`,
        ...(body ? { content: body } : {}),
        rawEventIds: [event.id],
        fields: buildInspectorFields([
          ["Type", event.type],
          ["Legacy type", event.legacyType],
          ["Status", status ? humanizeToken(status) : undefined],
          ["Actor", event.actor ? humanizeToken(event.actor) : toRowLabel(actor)],
          ["Timestamp", new Date(event.timestamp).toISOString()],
          ["Sequence", typeof event.seq === "number" ? String(event.seq) : undefined],
          ["Event ID", event.eventId],
          ["Step ID", event.stepId],
          ["Group ID", event.groupId],
          ["Duration", typeof durationMs === "number" ? `${durationMs}ms` : undefined],
        ]),
        json: {
          id: event.id,
          type: event.type,
          legacyType: event.legacyType,
          timestamp: event.timestamp,
          status: event.status,
          eventId: event.eventId,
          seq: event.seq,
          ts: event.ts,
          stepId: event.stepId,
          groupId: event.groupId,
          actor: event.actor,
          payload: event.payload,
        },
      },
    };
  });
}

export function filterTaskTraceRows(
  rows: TaskTraceRow[],
  actorFilter: TaskTraceRowActor | "all",
  query: string,
): TaskTraceRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (actorFilter !== "all" && row.actor !== actorFilter) return false;
    if (!normalizedQuery) return true;
    const haystack = [
      row.label,
      row.title,
      row.body,
      row.inspector.title,
      row.inspector.subtitle,
      row.inspector.content,
      ...row.inspector.fields.map((field) => `${field.label} ${field.value}`),
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function serializeTaskTraceRows(rows: TaskTraceRow[], tab: TaskTraceTab): string {
  if (tab === "debug") {
    return JSON.stringify(
      rows.map((row) => ({
        label: row.label,
        title: row.title,
        timestamp: row.timestamp,
        status: row.status,
        rawEventIds: row.rawEventIds,
        inspector: row.inspector,
      })),
      null,
      2,
    );
  }

  return rows
    .map((row) => {
      const pieces = [
        `[${new Date(row.timestamp).toISOString()}] ${row.label}: ${row.title}`,
        row.body || row.inspector.content || "",
        row.badges.length > 0 ? `Badges: ${row.badges.map((badge) => badge.label).join(", ")}` : "",
      ].filter(Boolean);
      return pieces.join("\n");
    })
    .join("\n\n");
}
