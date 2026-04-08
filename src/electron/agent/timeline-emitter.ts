import type {
  EventType,
  EvidenceRef,
  TimelineEventStatus,
  TimelineStage,
} from "../../shared/types";
import { stageToGroupId } from "../../shared/timeline-v2";

type EmitFn = (type: EventType, payload: Record<string, unknown>) => void;

interface StepDescriptor {
  id?: string;
  description?: string;
  error?: string;
}

interface GroupOptions {
  label?: string;
  semanticSummary?: string;
  maxParallel?: number;
  actor?: "system" | "agent" | "user" | "tool" | "subagent";
  status?: TimelineEventStatus;
  message?: string;
  legacyType?: EventType;
}

interface StepOptions {
  status?: "pending" | "in_progress" | "completed" | "failed" | "blocked" | "skipped" | "cancelled";
  actor?: "system" | "agent" | "user" | "tool" | "subagent";
  groupId?: string;
  message?: string;
  legacyType?: EventType;
  extraPayload?: Record<string, unknown>;
}

export class TimelineEmitter {
  constructor(
    private readonly taskId: string,
    private readonly emit: EmitFn,
  ) {}

  startGroup(stage: TimelineStage, options: GroupOptions = {}): void {
    this.emit("timeline_group_started", {
      taskId: this.taskId,
      stage,
      groupId: stageToGroupId(stage),
      groupLabel: options.label || stage,
      maxParallel:
        typeof options.maxParallel === "number" && Number.isFinite(options.maxParallel)
          ? Math.max(1, Math.floor(options.maxParallel))
          : undefined,
      status: "in_progress",
      actor: options.actor || "system",
      legacyType: options.legacyType || "step_started",
      message: options.message || (options.label ? `Starting ${options.label}` : `Starting ${stage}`),
    });
  }

  finishGroup(stage: TimelineStage, options: GroupOptions = {}): void {
    const status = options.status || "completed";
    this.emit("timeline_group_finished", {
      taskId: this.taskId,
      stage,
      groupId: stageToGroupId(stage),
      groupLabel: options.label || stage,
      status,
      actor: options.actor || "system",
      legacyType:
        options.legacyType || (status === "failed" ? "step_failed" : "step_completed"),
      message: options.message || (options.label ? `Completed ${options.label}` : `Completed ${stage}`),
    });
  }

  startGroupLane(groupId: string, options: GroupOptions = {}): void {
    const normalizedGroupId = typeof groupId === "string" ? groupId.trim() : "";
    if (!normalizedGroupId) return;
    const semanticSummary =
      typeof options.semanticSummary === "string" ? options.semanticSummary.trim() : "";
    this.emit("timeline_group_started", {
      groupId: normalizedGroupId,
      groupLabel: semanticSummary || options.label || normalizedGroupId,
      semanticSummary: semanticSummary || undefined,
      maxParallel:
        typeof options.maxParallel === "number" && Number.isFinite(options.maxParallel)
          ? Math.max(1, Math.floor(options.maxParallel))
          : undefined,
      status: options.status || "in_progress",
      actor: options.actor || "tool",
      legacyType: options.legacyType || "step_started",
      message:
        options.message ||
        (options.label ? `Starting ${options.label}` : `Starting ${normalizedGroupId}`),
    });
  }

  finishGroupLane(groupId: string, options: GroupOptions = {}): void {
    const normalizedGroupId = typeof groupId === "string" ? groupId.trim() : "";
    if (!normalizedGroupId) return;
    const status = options.status || "completed";
    const semanticSummary =
      typeof options.semanticSummary === "string" ? options.semanticSummary.trim() : "";
    this.emit("timeline_group_finished", {
      groupId: normalizedGroupId,
      groupLabel: semanticSummary || options.label || normalizedGroupId,
      semanticSummary: semanticSummary || undefined,
      status,
      actor: options.actor || "tool",
      legacyType:
        options.legacyType || (status === "failed" ? "step_failed" : "step_completed"),
      message:
        options.message ||
        (options.label ? `Completed ${options.label}` : `Completed ${normalizedGroupId}`),
    });
  }

  startStep(step: StepDescriptor, options: StepOptions = {}): void {
    this.emit("timeline_step_started", {
      ...(options.extraPayload || {}),
      stepId: step.id || `step:${this.taskId}`,
      step,
      groupId: options.groupId,
      status: "in_progress",
      actor: options.actor || "agent",
      message: options.message || step.description || "Step started",
      legacyType: options.legacyType || "step_started",
    });
  }

  updateStep(step: StepDescriptor, options: StepOptions = {}): void {
    this.emit("timeline_step_updated", {
      ...(options.extraPayload || {}),
      stepId: step.id || `step:${this.taskId}`,
      step,
      groupId: options.groupId,
      status: options.status || "in_progress",
      actor: options.actor || "agent",
      message: options.message || step.description || "Step updated",
      legacyType: options.legacyType || "progress_update",
    });
  }

  finishStep(step: StepDescriptor, options: StepOptions = {}): void {
    this.emit("timeline_step_finished", {
      ...(options.extraPayload || {}),
      stepId: step.id || `step:${this.taskId}`,
      step,
      groupId: options.groupId,
      status: options.status || "completed",
      actor: options.actor || "agent",
      message: options.message || step.description || "Step completed",
      legacyType: options.legacyType || "step_completed",
    });
  }

  failStep(step: StepDescriptor, reason: string, options: StepOptions = {}): void {
    this.emit("timeline_step_finished", {
      ...(options.extraPayload || {}),
      stepId: step.id || `step:${this.taskId}`,
      step: {
        ...step,
        error: reason,
      },
      groupId: options.groupId,
      status: "failed",
      actor: options.actor || "agent",
      message: reason || options.message || "Step failed",
      reason,
      legacyType: options.legacyType || "step_failed",
    });
  }

  attachEvidence(evidenceRefs: EvidenceRef[], options: { message?: string; stepId?: string } = {}): void {
    this.emit("timeline_evidence_attached", {
      evidenceRefs,
      stepId: options.stepId || `step:${this.taskId}`,
      status: "completed",
      actor: "agent",
      message: options.message || `Attached ${evidenceRefs.length} evidence reference(s)`,
      legacyType: "citations_collected",
    });
  }

  emitArtifact(path: string, options: { mimeType?: string; label?: string; stepId?: string } = {}): void {
    this.emit("timeline_artifact_emitted", {
      path,
      mimeType: options.mimeType,
      label: options.label,
      stepId: options.stepId || `step:${this.taskId}`,
      status: "completed",
      actor: "agent",
      legacyType: "artifact_created",
    });
  }

  emitCommandOutput(payload: Record<string, unknown>): void {
    this.emit("timeline_command_output", {
      ...payload,
      status: "in_progress",
      actor: "tool",
      legacyType: "command_output",
    });
  }
}

export function createTimelineEmitter(taskId: string, emit: EmitFn): TimelineEmitter {
  return new TimelineEmitter(taskId, emit);
}
