/**
 * Timeline Normalizer
 *
 * Transforms a flat array of raw task_events into UiTimelineEvent[] — a
 * semantic projection suitable for rendering in the CoWork OS timeline UI.
 *
 * Design principles:
 *  - Entirely rule-based / deterministic (no LLM calls)
 *  - task_events remain the source of truth; this is a pure read-side projection
 *  - Approval events are *never* batched or hidden
 *  - Error events break batches
 *  - Actor-aware so future sub-agents can slot in without changes
 */

import type {
  CanonicalActionKind,
  NormalizerInputEvent,
  NormalizerOptions,
  SemanticTimelineStatus,
  TimelineEvidence,
  TimelinePhase,
  UiTimelineEvent,
} from "../../../shared/timeline-events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function safeStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function durationMs(start: number, end: number): number {
  return Math.max(0, end - start);
}

// ---------------------------------------------------------------------------
// Canonical action kind mapping
// ---------------------------------------------------------------------------

const FILE_READ_TOOLS = new Set([
  "read_file",
  "list_directory",
  "get_file_info",
]);

const FILE_WRITE_TOOLS = new Set([
  "write_file",
  "copy_file",
  "create_directory",
  "move_file",
  "rename_file",
]);

const FILE_EDIT_TOOLS = new Set(["edit_file"]);

const FILE_DELETE_TOOLS = new Set(["delete_file"]);

const SEARCH_CODE_TOOLS = new Set([
  "search_files",
  "grep",
]);

const SEARCH_WEB_TOOLS = new Set(["web_search"]);

const SHELL_TOOLS = new Set(["run_command", "run_skill"]);

const BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_screenshot",
  "browser_snapshot",
  "browser_tabs",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_get_content",
  "browser_click",
  "browser_hover",
  "browser_drag",
  "browser_fill",
  "browser_type",
  "browser_press",
  "browser_wait",
  "browser_scroll",
  "browser_select",
  "browser_get_text",
  "browser_evaluate",
  "browser_upload_file",
  "browser_handle_dialog",
  "browser_console",
  "browser_network",
  "browser_downloads",
  "browser_storage",
  "browser_emulate",
  "browser_trace_start",
  "browser_trace_stop",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_save_pdf",
  "browser_close",
]);

const MEMORY_READ_TYPES = new Set([
  "memory_retrieved",
  "memory_queried",
]);

const MEMORY_WRITE_TYPES = new Set([
  "memory_stored",
  "memory_updated",
  "memory_deleted",
]);

/** Map a raw event to a canonical action kind */
function toCanonicalKind(event: NormalizerInputEvent): CanonicalActionKind {
  const type = event.type;
  const payload = asObject(event.payload);
  const tool = safeStr(payload.tool);

  // Approval events
  if (type === "approval_requested") return "approval.request";
  if (type === "approval_granted" || type === "approval_denied") return "approval.resolve";

  // Artifact / output
  if (type === "artifact_created" || type === "timeline_artifact_emitted") return "artifact.create";

  // Task completion
  if (type === "task_completed") return "task.complete";

  // Sub-agent lifecycle
  if (
    type === "subagent_start" ||
    type === "agent_start" ||
    type === "agent_started"
  )
    return "agent.start";
  if (
    type === "subagent_stop" ||
    type === "agent_stop" ||
    type === "agent_stopped" ||
    type === "agent_finished"
  )
    return "agent.stop";

  // Memory
  if (MEMORY_READ_TYPES.has(type)) return "memory.read";
  if (MEMORY_WRITE_TYPES.has(type)) return "memory.write";

  // Tool calls — inspect payload.tool for fine-grained classification
  if (type === "tool_call" || type === "tool_use") {
    if (FILE_READ_TOOLS.has(tool)) return "file.read";
    if (FILE_WRITE_TOOLS.has(tool)) return "file.write";
    if (FILE_EDIT_TOOLS.has(tool)) return "file.edit";
    if (FILE_DELETE_TOOLS.has(tool)) return "file.delete";
    if (SEARCH_CODE_TOOLS.has(tool)) return "search.code";
    if (SEARCH_WEB_TOOLS.has(tool)) return "search.web";
    if (SHELL_TOOLS.has(tool)) return "shell.run";
    if (BROWSER_TOOLS.has(tool)) return "browser.action";
    // Unknown tool — fall through to generic
  }

  // Direct event types that match tool names (some emitters use type = tool name)
  if (FILE_READ_TOOLS.has(type)) return "file.read";
  if (FILE_WRITE_TOOLS.has(type)) return "file.write";
  if (FILE_EDIT_TOOLS.has(type)) return "file.edit";
  if (FILE_DELETE_TOOLS.has(type)) return "file.delete";
  if (SEARCH_CODE_TOOLS.has(type)) return "search.code";
  if (SEARCH_WEB_TOOLS.has(type)) return "search.web";
  if (SHELL_TOOLS.has(type)) return "shell.run";
  if (BROWSER_TOOLS.has(type)) return "browser.action";
  if (type === "browser_action") return "browser.action";

  // Timeline step events are general step updates
  if (
    type === "timeline_step_started" ||
    type === "timeline_step_updated" ||
    type === "timeline_step_finished" ||
    type === "timeline_group_started" ||
    type === "timeline_group_finished"
  )
    return "step.update";

  return "generic";
}

// ---------------------------------------------------------------------------
// Phase inference
// ---------------------------------------------------------------------------

const EXPLORE_KINDS = new Set<CanonicalActionKind>([
  "file.read",
  "search.code",
  "search.web",
  "memory.read",
]);

const EXECUTE_KINDS = new Set<CanonicalActionKind>([
  "file.write",
  "file.edit",
  "file.delete",
  "shell.run",
  "browser.action",
  "memory.write",
]);

/** Infer a TimelinePhase from a canonical action kind and event context */
function inferPhase(event: NormalizerInputEvent, kind: CanonicalActionKind): TimelinePhase {
  if (kind === "task.complete" || kind === "artifact.create") return "complete";
  if (kind === "approval.request" || kind === "approval.resolve") return "execute";
  if (kind === "agent.start" || kind === "agent.stop") return "execute";

  // Use stage hint from payload if present (timeline_group_* events)
  const payload = asObject(event.payload);
  const stage = safeStr(payload.stage).toUpperCase();
  if (stage === "DISCOVER") return "explore";
  if (stage === "BUILD") return "execute";
  if (stage === "VERIFY") return "verify";
  if (stage === "FIX") return "execute";
  if (stage === "DELIVER") return "complete";

  if (EXPLORE_KINDS.has(kind)) return "explore";
  if (EXECUTE_KINDS.has(kind)) return "execute";

  // Verification patterns in event type
  if (
    event.type.includes("verif") ||
    event.type.includes("lint") ||
    event.type.includes("test")
  )
    return "verify";

  return "execute";
}

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

function extractEvidence(events: NormalizerInputEvent[]): TimelineEvidence[] {
  const evidence: TimelineEvidence[] = [];
  const seenPaths = new Set<string>();
  const seenRuntimeEvidence = new Set<string>();

  for (const event of events) {
    const payload = asObject(event.payload);
    const kind = toCanonicalKind(event);
    const envelope = asObject(payload.envelope);
    const envelopeEvidence = Array.isArray(envelope.evidence) ? envelope.evidence : [];

    for (const item of envelopeEvidence) {
      const entry = asObject(item);
      const type = safeStr(entry.type);
      const label = safeStr(entry.label) || "Runtime evidence";
      const value = safeStr(entry.value);
      const extra = asObject(entry.extra);
      const dedupeKey = `${type}:${label}:${value}`;
      if (!type || !value || seenRuntimeEvidence.has(dedupeKey)) continue;
      seenRuntimeEvidence.add(dedupeKey);

      if (type === "file") {
        if (!seenPaths.has(value)) {
          seenPaths.add(value);
          evidence.push({
            type: "file",
            path: value,
            operation: safeStr(extra.operation) as "read" | "write" | "edit" | "delete" | undefined,
            ...(safeStr(extra.lines) ? { lines: safeStr(extra.lines) } : {}),
          });
        }
        continue;
      }

      if (type === "command") {
        evidence.push({
          type: "command",
          label,
          command: value,
          ...(safeStr(extra.output) ? { output: safeStr(extra.output) } : {}),
        });
        continue;
      }

      if (type === "url") {
        evidence.push({ type: "url", label, url: value });
        continue;
      }

      if (type === "artifact") {
        evidence.push({
          type: "artifact",
          label,
          path: value,
          ...(safeStr(extra.mimeType) ? { mimeType: safeStr(extra.mimeType) } : {}),
        });
        continue;
      }

      if (type === "runtime_log") {
        evidence.push({
          type: "runtime_log",
          label,
          message: value,
          ...(safeStr(extra.source) ? { source: safeStr(extra.source) } : {}),
        });
      }
    }

    if (kind === "file.read" || kind === "file.write" || kind === "file.edit" || kind === "file.delete") {
      const path =
        safeStr(payload.path) ||
        safeStr(payload.filePath) ||
        safeStr(payload.file) ||
        safeStr((asObject(payload.input)).path);
      if (path && !seenPaths.has(path)) {
        seenPaths.add(path);
        const opMap: Partial<Record<CanonicalActionKind, "read" | "write" | "edit" | "delete">> = {
          "file.read": "read",
          "file.write": "write",
          "file.edit": "edit",
          "file.delete": "delete",
        };
        evidence.push({
          type: "file",
          path,
          operation: opMap[kind] ?? "read",
        });
      }
    }

    if (kind === "search.code") {
      const query =
        safeStr(payload.pattern) ||
        safeStr(payload.query) ||
        safeStr(payload.regex) ||
        safeStr((asObject(payload.input)).pattern);
      if (query) {
        evidence.push({ type: "query", label: "Code search", query });
      }
    }

    if (kind === "search.web") {
      const query = safeStr(payload.query) || safeStr((asObject(payload.input)).query);
      if (query) {
        evidence.push({ type: "query", label: "Web search", query });
      }
    }

    if (kind === "shell.run") {
      const command =
        safeStr(payload.command) ||
        safeStr((asObject(payload.input)).command);
      if (command) {
        const output = safeStr(payload.output) || safeStr(payload.stdout);
        evidence.push({
          type: "command",
          label: "Shell command",
          command,
          ...(output ? { output } : {}),
        });
      }
    }

    if (kind === "artifact.create") {
      const path = safeStr(payload.path) || safeStr(payload.filePath);
      const label = safeStr(payload.name) || safeStr(payload.label) || "Artifact";
      if (path) {
        evidence.push({
          type: "artifact",
          label,
          path,
          ...(safeStr(payload.mimeType) ? { mimeType: safeStr(payload.mimeType) } : {}),
        });
      }
    }

    if (kind === "approval.request") {
      const label = safeStr(payload.reason) || safeStr(payload.message) || "Approval required";
      const risk = inferApprovalRisk(payload);
      evidence.push({ type: "approval", label, risk });
    }

    // URL evidence from browser events
    if (kind === "browser.action") {
      const url = safeStr(payload.url) || safeStr((asObject(payload.input)).url);
      if (url) {
        evidence.push({ type: "url", label: "Browser", url });
      }
    }
  }

  return evidence;
}

function inferApprovalRisk(payload: Record<string, unknown>): "low" | "medium" | "high" {
  const risk = safeStr(payload.risk).toLowerCase();
  if (risk === "high") return "high";
  if (risk === "medium") return "medium";
  if (risk === "low") return "low";

  // Heuristic: destructive verbs → high
  const command = safeStr(payload.command) + " " + safeStr(payload.reason);
  if (/\b(rm|delete|drop|truncate|format|wipe|purge)\b/i.test(command)) return "high";
  if (/\b(write|push|deploy|install|sudo|chmod|chown)\b/i.test(command)) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Summary generation — deterministic templates
// ---------------------------------------------------------------------------

function buildSummary(events: NormalizerInputEvent[], kind: CanonicalActionKind): string {
  if (events.length === 0) return "Worked";

  const payload = asObject(events[0].payload);

  switch (kind) {
    case "file.read": {
      const count = events.length;
      const paths = events
        .map((e) => {
          const p = asObject(e.payload);
          return safeStr(p.path) || safeStr(p.filePath) || safeStr((asObject(p.input)).path);
        })
        .filter(Boolean);
      const commonPrefix = findCommonPrefix(paths);
      if (commonPrefix && paths.length > 1) {
        return `Read ${count} file${count === 1 ? "" : "s"} in ${commonPrefix}`;
      }
      if (paths.length === 1) {
        return `Read ${shortenPath(paths[0])}`;
      }
      return `Read ${count} file${count === 1 ? "" : "s"}`;
    }

    case "file.write": {
      const count = events.length;
      const paths = events
        .map((e) => {
          const p = asObject(e.payload);
          return safeStr(p.path) || safeStr(p.filePath);
        })
        .filter(Boolean);
      if (paths.length === 1) return `Created ${shortenPath(paths[0])}`;
      return `Created ${count} file${count === 1 ? "" : "s"}`;
    }

    case "file.edit": {
      const count = events.length;
      const paths = events
        .map((e) => {
          const p = asObject(e.payload);
          return safeStr(p.path) || safeStr(p.filePath);
        })
        .filter(Boolean);
      if (paths.length === 1) return `Updated ${shortenPath(paths[0])}`;
      const commonPrefix = findCommonPrefix(paths);
      if (commonPrefix && paths.length > 1) {
        return `Updated ${count} file${count === 1 ? "" : "s"} in ${commonPrefix}`;
      }
      return `Updated ${count} file${count === 1 ? "" : "s"}`;
    }

    case "file.delete": {
      const paths = events
        .map((e) => {
          const p = asObject(e.payload);
          return safeStr(p.path) || safeStr(p.filePath);
        })
        .filter(Boolean);
      if (paths.length === 1) return `Deleted ${shortenPath(paths[0])}`;
      return `Deleted ${events.length} file${events.length === 1 ? "" : "s"}`;
    }

    case "search.code": {
      const count = events.length;
      if (count === 1) {
        const query = safeStr(payload.pattern) || safeStr(payload.query) || safeStr(payload.regex);
        if (query) return `Searched codebase for "${truncate(query, 40)}"`;
      }
      return `Searched codebase (${count} quer${count === 1 ? "y" : "ies"})`;
    }

    case "search.web": {
      const query = safeStr(payload.query) || safeStr((asObject(payload.input)).query);
      if (query) return `Searched the web for "${truncate(query, 40)}"`;
      return "Searched the web";
    }

    case "shell.run": {
      const command = safeStr(payload.command) || safeStr((asObject(payload.input)).command);
      if (command) return `Ran command: ${truncate(command, 60)}`;
      return "Ran shell command";
    }

    case "browser.action": {
      const url = safeStr(payload.url) || safeStr((asObject(payload.input)).url);
      if (url) return `Browsed ${truncate(url, 60)}`;
      return "Browser action";
    }

    case "approval.request": {
      const reason = safeStr(payload.reason) || safeStr(payload.message);
      if (reason) return `Needs approval: ${truncate(reason, 60)}`;
      return "Needs approval to proceed";
    }

    case "approval.resolve": {
      if (events[0].type === "approval_granted") return "Approval granted";
      if (events[0].type === "approval_denied") return "Approval denied";
      return "Approval resolved";
    }

    case "artifact.create": {
      const path = safeStr(payload.path) || safeStr(payload.filePath);
      if (path) return `Created artifact: ${shortenPath(path)}`;
      return "Created artifact";
    }

    case "memory.read": return "Retrieved relevant memories";
    case "memory.write": return "Stored new memory";

    case "agent.start": {
      const actor = safeStr(payload.actor) || safeStr(payload.agentName) || "agent";
      return `Spawned ${actor} agent`;
    }
    case "agent.stop": {
      const actor = safeStr(payload.actor) || safeStr(payload.agentName) || "agent";
      return `${capitalise(actor)} agent finished`;
    }

    case "task.complete": return "Task completed";

    case "step.update": {
      const isTimelineGroup =
        events[0]?.type === "timeline_group_started" || events[0]?.type === "timeline_group_finished";
      const groupLabel = safeStr(payload.groupLabel);
      const message = safeStr(payload.message);
      const preferredMessage =
        isTimelineGroup && groupLabel
          ? groupLabel
          : message.replace(/:\s*\d+\s+succeeded(?:,\s*\d+\s+failed)?$/i, "").trim();
      const summary =
        preferredMessage ||
        groupLabel ||
        safeStr(asObject(payload.step).description);
      if (summary) return truncate(summary, 80);
      return "Step in progress";
    }

    default:
      return "Worked";
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function shortenPath(path: string): string {
  // Keep last two segments for readability
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

function findCommonPrefix(paths: string[]): string {
  if (paths.length < 2) return "";
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));
  const segments = normalized[0].split("/");
  let commonParts: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (normalized.every((p) => p.split("/")[i] === seg)) {
      commonParts.push(seg);
    } else {
      break;
    }
  }
  const prefix = commonParts.join("/");
  // Only return prefix if it's at least one meaningful directory deep
  if (prefix.length < 2 || commonParts.length < 2) return "";
  return prefix + "/";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function capitalise(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Status resolution
// ---------------------------------------------------------------------------

function resolveStatus(events: NormalizerInputEvent[]): SemanticTimelineStatus {
  const last = events[events.length - 1];
  if (!last) return "success";
  if (last.status === "failed" || last.type === "timeline_error") return "error";
  if (last.status === "blocked") return "blocked";
  if (last.type === "approval_denied") return "blocked";
  if (last.type === "approval_granted") return "success";
  if (
    last.status === "completed" ||
    last.status === "skipped" ||
    last.status === "cancelled" ||
    last.type === "task_completed" ||
    last.type === "timeline_group_finished" ||
    last.type === "timeline_step_finished"
  )
    return "success";
  if (last.status === "in_progress" || last.status === "pending") return "running";
  return "success";
}

// ---------------------------------------------------------------------------
// Batch boundary detection
// ---------------------------------------------------------------------------

/** Events that must never be merged into a batch */
const BATCH_BREAKERS = new Set<string>([
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "timeline_error",
  "task_completed",
  "subagent_start",
  "agent_start",
  "agent_started",
  "subagent_stop",
  "agent_stop",
  "agent_stopped",
  "agent_finished",
]);

/** Action kind families that can be batched together */
const BATCHABLE_FAMILIES: Record<CanonicalActionKind, string> = {
  "file.read": "files",
  "file.write": "files",
  "file.edit": "files",
  "file.delete": "files",
  "search.code": "search",
  "search.web": "search",
  "shell.run": "shell",
  "browser.action": "browser",
  "approval.request": "_none_",
  "approval.resolve": "_none_",
  "artifact.create": "_none_",
  "memory.read": "memory",
  "memory.write": "memory",
  "agent.start": "_none_",
  "agent.stop": "_none_",
  "task.complete": "_none_",
  "step.update": "step",
  "generic": "_none_",
};

interface EventGroup {
  events: NormalizerInputEvent[];
  kind: CanonicalActionKind;
  actor: string;
  phase: TimelinePhase;
  family: string;
  lastTimestamp: number;
}

function canMerge(group: EventGroup, event: NormalizerInputEvent, kind: CanonicalActionKind, batchWindowMs: number): boolean {
  if (BATCH_BREAKERS.has(event.type)) return false;
  if (BATCH_BREAKERS.has(group.events[group.events.length - 1]?.type ?? "")) return false;

  const family = BATCHABLE_FAMILIES[kind];
  if (family === "_none_") return false;
  if (family !== group.family) return false;

  const actor = resolveActor(event);
  if (actor !== group.actor) return false;

  const gap = (event.timestamp ?? 0) - group.lastTimestamp;
  if (gap > batchWindowMs) return false;

  return true;
}

function resolveActor(event: NormalizerInputEvent, defaultActor = "Main"): string {
  if (typeof event.actor === "string" && event.actor.trim().length > 0) {
    return event.actor.trim();
  }
  const payload = asObject(event.payload);
  const actor = safeStr(payload.actor) || safeStr(payload.agentName);
  return actor || defaultActor;
}

// ---------------------------------------------------------------------------
// Canonical event → internal accumulator group
// ---------------------------------------------------------------------------

function startGroup(event: NormalizerInputEvent, kind: CanonicalActionKind, defaultActor: string): EventGroup {
  const phase = inferPhase(event, kind);
  const actor = resolveActor(event, defaultActor);
  const family = BATCHABLE_FAMILIES[kind];
  return {
    events: [event],
    kind,
    actor,
    phase,
    family,
    lastTimestamp: event.timestamp ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Group → UiTimelineEvent projection
// ---------------------------------------------------------------------------

function projectGroupToApproval(group: EventGroup): UiTimelineEvent {
  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  const payload = asObject(first.payload);
  const risk = inferApprovalRisk(payload);

  let status: "waiting" | "success" | "blocked" = "waiting";
  if (last.type === "approval_granted") status = "success";
  else if (last.type === "approval_denied") status = "blocked";

  return {
    id: `sem-${first.id}`,
    kind: "approval",
    phase: "execute",
    actor: resolveActor(first),
    summary: buildSummary(group.events, group.kind),
    status,
    risk,
    rawEventIds: group.events.map((e) => e.id),
    evidence: extractEvidence(group.events),
    startedAt: toIso(first.timestamp ?? 0),
    ...(last !== first ? { endedAt: toIso(last.timestamp ?? 0) } : {}),
    expandable: true,
  };
}

function projectGroupToAgent(group: EventGroup): UiTimelineEvent {
  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  const payload = asObject(first.payload);
  const actor =
    safeStr(payload.actor) ||
    safeStr(payload.agentName) ||
    resolveActor(first);

  const startTs = first.timestamp ?? 0;
  const endTs = last.timestamp ?? 0;

  return {
    id: `sem-${first.id}`,
    kind: "agent",
    phase: group.phase,
    actor,
    summary: buildSummary(group.events, group.kind),
    status: resolveStatus(group.events),
    rawEventIds: group.events.map((e) => e.id),
    evidence: extractEvidence(group.events),
    startedAt: toIso(startTs),
    ...(endTs !== startTs ? { endedAt: toIso(endTs), durationMs: durationMs(startTs, endTs) } : {}),
    expandable: true,
  };
}

function projectGroupToSummary(group: EventGroup): UiTimelineEvent {
  const first = group.events[0];
  const last = group.events[group.events.length - 1];

  const startTs = first.timestamp ?? 0;
  const endTs = last.timestamp ?? 0;
  const dur = durationMs(startTs, endTs);

  return {
    id: `sem-${first.id}`,
    kind: "summary",
    phase: group.phase,
    actor: group.actor !== "Main" ? group.actor : undefined,
    summary: buildSummary(group.events, group.kind),
    status: resolveStatus(group.events),
    startedAt: toIso(startTs),
    ...(endTs !== startTs ? { endedAt: toIso(endTs) } : {}),
    ...(dur > 0 ? { durationMs: dur } : {}),
    evidence: extractEvidence(group.events),
    rawEventIds: group.events.map((e) => e.id),
    expandable: true,
    actionKind: group.kind,
  };
}

function projectGroup(group: EventGroup): UiTimelineEvent {
  if (group.kind === "approval.request" || group.kind === "approval.resolve") {
    return projectGroupToApproval(group);
  }
  if (group.kind === "agent.start" || group.kind === "agent.stop") {
    return projectGroupToAgent(group);
  }
  return projectGroupToSummary(group);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a flat array of raw task events into semantic UiTimelineEvent[].
 *
 * @param raw - Raw events from task_events table (in chronological order)
 * @param options - Optional tuning parameters
 */
export function normalizeTaskEvents(
  raw: NormalizerInputEvent[],
  options?: NormalizerOptions,
): UiTimelineEvent[] {
  const batchWindowMs = options?.batchWindowMs ?? 5000;
  const defaultActor = options?.defaultActor ?? "Main";

  if (raw.length === 0) return [];

  const groups: EventGroup[] = [];

  for (const event of raw) {
    const kind = toCanonicalKind(event);
    const last = groups.at(-1);

    if (last && canMerge(last, event, kind, batchWindowMs)) {
      last.events.push(event);
      last.lastTimestamp = event.timestamp ?? 0;
    } else {
      groups.push(startGroup(event, kind, defaultActor));
    }
  }

  return groups.map(projectGroup);
}

// ---------------------------------------------------------------------------
// Completion summary builder — reuses the same projection
// ---------------------------------------------------------------------------

export interface CompletionSummaryResult {
  explored: string[];
  changed: string[];
  verified: string[];
  needsAttention: string[];
  artifacts: string[];
}

/**
 * Build a structured completion summary from semantic events.
 * Reused by finalizeTask() so timeline and completion toast tell the same story.
 */
export function buildCompletionSummaryFromUiEvents(
  events: UiTimelineEvent[],
): CompletionSummaryResult {
  const explored: string[] = [];
  const changed: string[] = [];
  const verified: string[] = [];
  const needsAttention: string[] = [];
  const artifacts: string[] = [];

  for (const event of events) {
    if (event.kind === "approval" && event.status === "blocked") {
      needsAttention.push(event.summary);
      continue;
    }
    if (event.kind === "approval") continue;
    if (event.kind === "agent") continue;

    const summary = event as import("../../../shared/timeline-events").SummaryUiEvent;

    switch (summary.actionKind) {
      case "file.read":
      case "search.code":
      case "search.web":
        explored.push(summary.summary);
        break;
      case "file.write":
      case "file.edit":
      case "file.delete":
        changed.push(summary.summary);
        break;
      case "artifact.create":
        for (const ev of summary.evidence) {
          if (ev.type === "artifact") artifacts.push(ev.path);
        }
        break;
      case "step.update":
        if (summary.phase === "verify") verified.push(summary.summary);
        break;
      default:
        break;
    }
  }

  return { explored, changed, verified, needsAttention, artifacts };
}

// Re-export types so callers can import from this module
export type { UiTimelineEvent, NormalizerInputEvent, NormalizerOptions };
