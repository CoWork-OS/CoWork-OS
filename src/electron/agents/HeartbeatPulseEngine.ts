import {
  AgentRole,
  HeartbeatDeferredState,
  HeartbeatDispatchKind,
  HeartbeatPulseResultKind,
  HeartbeatSignal,
  ProactiveTaskDefinition,
} from "../../shared/types";
import type { HeartbeatChecklistItem } from "./heartbeat-maintenance";

export interface HeartbeatPulseInput {
  agent: AgentRole;
  signals: HeartbeatSignal[];
  pendingMentions: number;
  assignedTasks: number;
  hasActiveForegroundTask: boolean;
  manualOverride: boolean;
  dueChecklistItems: HeartbeatChecklistItem[];
  dueProactiveTasks: ProactiveTaskDefinition[];
  cooldownUntil?: number;
  dispatchesToday: number;
  maxDispatchesPerDay: number;
  hasInFlightDispatch: boolean;
}

export interface HeartbeatPulseDecision {
  kind: HeartbeatPulseResultKind;
  dispatchKind?: HeartbeatDispatchKind;
  reason: string;
  deferred?: HeartbeatDeferredState;
  evidenceRefs: string[];
  signalIds: string[];
  signalCount: number;
  compressedSignalCount: number;
  dueChecklistCount: number;
  dueProactiveCount: number;
  workspaceId?: string;
}

/**
 * Returns the effective strength of a signal set as a value in [0, 1].
 * Uses urgency as a floor so that, e.g., a critical signal always scores >= 0.9
 * regardless of its raw confidence value.
 */
export function getSignalStrength(signals: HeartbeatSignal[]): number {
  if (signals.length === 0) return 0;
  return Math.max(
    ...signals.map((signal) => {
      switch (signal.urgency) {
        case "critical":
          return Math.max(0.9, signal.confidence);
        case "high":
          return Math.max(0.7, signal.confidence);
        case "medium":
          return Math.max(0.4, signal.confidence);
        default:
          return Math.max(0.2, signal.confidence);
      }
    }),
  );
}

export class HeartbeatPulseEngine {
  evaluate(input: HeartbeatPulseInput): HeartbeatPulseDecision {
    const profile =
      input.agent.heartbeatPolicy?.profile || input.agent.heartbeatProfile || "observer";
    const signalStrength = getSignalStrength(input.signals);
    const signalIds = input.signals.map((signal) => signal.id);
    const evidenceRefs = Array.from(
      new Set(input.signals.flatMap((signal) => signal.evidenceRefs || [])),
    );
    const compressedSignalCount = input.signals.reduce(
      (sum, signal) => sum + signal.mergedCount,
      0,
    );
    const workspaceId = input.signals.find((signal) => signal.workspaceId)?.workspaceId;
    const topFamilies = Array.from(
      new Set(input.signals.map((signal) => signal.signalFamily)),
    ).slice(0, 3);

    if (
      input.hasActiveForegroundTask &&
      !input.manualOverride &&
      (input.signals.length > 0 || input.pendingMentions > 0 || input.assignedTasks > 0)
    ) {
      const reason = `Foreground work active; deferred ${compressedSignalCount || input.signals.length} merged signals`;
      return {
        kind: "deferred",
        reason,
        deferred: {
          active: true,
          reason: "foreground_active",
          summary: reason,
          deferredAt: Date.now(),
          compressedSignalCount,
        },
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    if (input.hasInFlightDispatch) {
      return {
        kind: "idle",
        reason: "Dispatch already in flight",
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    if (!input.manualOverride && input.cooldownUntil && input.cooldownUntil > Date.now()) {
      return {
        kind: "idle",
        reason: "Dispatch cooldown active",
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    if (!input.manualOverride && input.dispatchesToday >= input.maxDispatchesPerDay) {
      return {
        kind: "idle",
        reason: "Daily dispatch budget exhausted",
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    if (
      profile === "observer" &&
      !input.manualOverride &&
      input.pendingMentions === 0 &&
      input.assignedTasks === 0 &&
      input.dueChecklistItems.length === 0 &&
      input.dueProactiveTasks.length === 0
    ) {
      return {
        kind: signalStrength >= 0.8 ? "suggestion" : "idle",
        reason:
          signalStrength >= 0.8
            ? `Observer noticed strong signals: ${topFamilies.join(", ")}`
            : "No actionable heartbeat state",
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    if (input.pendingMentions > 0 || input.assignedTasks > 0 || input.manualOverride) {
      const dispatchKind = profile === "dispatcher" ? "task" : "suggestion";
      return {
        kind: dispatchKind === "task" ? "dispatch_task" : "suggestion",
        dispatchKind,
        reason: input.manualOverride
          ? "Manual wake requested immediate review"
          : `Pending work detected (${input.pendingMentions} mentions, ${input.assignedTasks} assigned tasks)`,
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    const cronDue = input.dueProactiveTasks.filter((task) => task.executionMode === "cron_handoff");
    if (cronDue.length > 0) {
      return {
        kind: "handoff_to_cron",
        dispatchKind: "cron_handoff",
        reason: `${cronDue.length} heavyweight recurring checks should hand off to cron`,
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    if (
      profile !== "observer" &&
      (input.dueChecklistItems.length > 0 ||
        input.dueProactiveTasks.some((task) => task.executionMode !== "pulse_only"))
    ) {
      const dispatchKind = profile === "dispatcher" ? "runbook" : "suggestion";
      return {
        kind: dispatchKind === "runbook" ? "dispatch_runbook" : "suggestion",
        dispatchKind,
        reason: `Maintenance due (${input.dueChecklistItems.length} checklist, ${input.dueProactiveTasks.length} proactive)`,
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    if (signalStrength >= 0.72) {
      const dispatchKind = profile === "dispatcher" ? "task" : "suggestion";
      return {
        kind: dispatchKind === "task" ? "dispatch_task" : "suggestion",
        dispatchKind,
        reason: `Signal strength ${signalStrength.toFixed(2)} crossed dispatch threshold`,
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    if (
      input.dueChecklistItems.length > 0 ||
      input.dueProactiveTasks.some((task) => task.executionMode === "pulse_only")
    ) {
      return {
        kind: "suggestion",
        dispatchKind: "suggestion",
        reason: "Pulse found due low-cost maintenance work",
        evidenceRefs,
        signalIds,
        signalCount: input.signals.length,
        compressedSignalCount,
        dueChecklistCount: input.dueChecklistItems.length,
        dueProactiveCount: input.dueProactiveTasks.length,
        workspaceId,
      };
    }

    return {
      kind: "idle",
      reason: "No actionable heartbeat state",
      evidenceRefs,
      signalIds,
      signalCount: input.signals.length,
      compressedSignalCount,
      dueChecklistCount: input.dueChecklistItems.length,
      dueProactiveCount: input.dueProactiveTasks.length,
      workspaceId,
    };
  }
}
