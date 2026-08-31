/**
 * Semantic timeline event model for the CoWork OS UI layer.
 *
 * These types represent the *presentation* model produced by the timeline
 * normalizer. They are derived from raw task_events on read and are never
 * persisted — task_events remain the single source of truth.
 *
 * Design goals:
 *  - Human-readable by default (concise/verbose toggle supported)
 *  - Every card is expandable into concrete evidence and raw event IDs
 *  - Actor-aware so future sub-agent lanes can slot in without redesign
 *  - Approval events are never batched or hidden
 */

// ---------------------------------------------------------------------------
// Phase — the high-level work stage visible as sticky chips in the timeline
// ---------------------------------------------------------------------------

export type TimelinePhase =
  | "intake" // Initial task intake, context loading
  | "plan" // Goal decomposition, planning
  | "explore" // Read-heavy codebase / web research
  | "execute" // Write / edit / shell / browser actions
  | "verify" // Tests, lint, validation
  | "complete"; // Task finalization, artifact emission

// ---------------------------------------------------------------------------
// Status — the visual state of a semantic timeline card
// ---------------------------------------------------------------------------

export type SemanticTimelineStatus =
  | "running" // Currently in progress (spinner)
  | "success" // Finished without error
  | "error" // Finished with error
  | "waiting" // Waiting for approval or user input
  | "blocked"; // Blocked (approval denied / hard limit hit)

// ---------------------------------------------------------------------------
// Canonical action kind — normalizer maps raw EventType → one of these
// ---------------------------------------------------------------------------

export type CanonicalActionKind =
  | "file.read"
  | "file.write"
  | "file.edit"
  | "file.delete"
  | "search.code"
  | "search.web"
  | "shell.run"
  | "browser.action"
  | "approval.request"
  | "approval.resolve"
  | "artifact.create"
  | "memory.read"
  | "memory.write"
  | "agent.start"
  | "agent.stop"
  | "task.complete"
  | "step.update"
  | "generic";

// ---------------------------------------------------------------------------
// Evidence — proof attached to a semantic card
// ---------------------------------------------------------------------------

export type TimelineEvidence =
  | {
      type: "file";
      path: string;
      lines?: string;
      operation?: "read" | "write" | "edit" | "delete";
    }
  | {
      type: "command";
      label: string;
      command: string;
      output?: string;
    }
  | {
      type: "query";
      label: string;
      query: string;
    }
  | {
      type: "artifact";
      label: string;
      path: string;
      mimeType?: string;
    }
  | {
      type: "approval";
      label: string;
      risk?: "low" | "medium" | "high";
      reason?: string;
    }
  | {
      type: "url";
      label: string;
      url: string;
    }
  | {
      type: "runtime_log";
      label: string;
      message: string;
      source?: string;
    };

// ---------------------------------------------------------------------------
// UiTimelineEvent — the three card variants rendered by SemanticTimeline
// ---------------------------------------------------------------------------

/** A batched summary of multiple related tool actions */
export interface SummaryUiEvent {
  id: string;
  kind: "summary";
  phase: TimelinePhase;
  actor?: string;
  /** Short human-readable description, e.g. "Read 6 files in src/electron/agent/tools/" */
  summary: string;
  status: SemanticTimelineStatus;
  startedAt: string; // ISO timestamp
  endedAt?: string;
  durationMs?: number;
  evidence: TimelineEvidence[];
  rawEventIds: string[];
  expandable: true;
  /** Action family this group represents, used for icon selection */
  actionKind: CanonicalActionKind;
}

/** An explicit approval request / resolution */
export interface ApprovalUiEvent {
  id: string;
  kind: "approval";
  phase: "execute";
  actor?: string;
  summary: string;
  status: "waiting" | "success" | "blocked";
  risk: "low" | "medium" | "high";
  rawEventIds: string[];
  evidence: TimelineEvidence[];
  startedAt: string;
  endedAt?: string;
  expandable: true;
}

/** A sub-agent lifecycle entry (start / running / done) */
export interface AgentUiEvent {
  id: string;
  kind: "agent";
  phase: TimelinePhase;
  actor: string;
  summary: string;
  status: SemanticTimelineStatus;
  rawEventIds: string[];
  evidence: TimelineEvidence[];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  expandable: true;
  /** Nested summary cards emitted by this actor */
  children?: SummaryUiEvent[];
}

export type UiTimelineEvent = SummaryUiEvent | ApprovalUiEvent | AgentUiEvent;

// ---------------------------------------------------------------------------
// Normalizer input / output contract
// ---------------------------------------------------------------------------

/** Minimal shape the normalizer needs from a raw event */
export interface NormalizerInputEvent {
  id: string;
  taskId: string;
  timestamp: number;
  type: string;
  payload: unknown;
  schemaVersion: number;
  eventId?: string;
  seq?: number;
  ts?: number;
  status?: string;
  stepId?: string;
  groupId?: string;
  actor?: string;
  legacyType?: string;
}

/** Options controlling normalizer behavior */
export interface NormalizerOptions {
  /** Maximum gap between events in the same batch (ms). Default: 5000 */
  batchWindowMs?: number;
  /** Default actor label when actor field is absent */
  defaultActor?: string;
}
