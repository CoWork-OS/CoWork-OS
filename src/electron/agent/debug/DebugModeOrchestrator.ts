import type { EvidenceRef } from "../../../shared/types";
import {
  closeDebugRuntimeSession,
  openDebugRuntimeSession,
  type DebugIngestEntry,
} from "./DebugRuntimeServer";
import { DEBUG_PHASE_ORDER, type DebugPhase } from "../../../shared/debug-mode";

export type DebugTimelineEmit = (type: string, payload: Record<string, unknown>) => void;

function makeEvidenceRef(line: string): EvidenceRef {
  return {
    evidenceId: `debug_runtime:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
    sourceType: "tool_output",
    sourceUrlOrPath: "cowork://debug-runtime",
    snippet: line.length > 600 ? `${line.slice(0, 600)}…` : line,
    capturedAt: Date.now(),
  };
}

/**
 * Starts local runtime ingest and emits initial timeline markers for debug mode.
 */
export async function startDebugModeSession(
  taskId: string,
  emit: DebugTimelineEmit,
): Promise<{ ingestUrl: string }> {
  const { ingestUrl } = await openDebugRuntimeSession(taskId, (entry: DebugIngestEntry) => {
    emit("timeline_evidence_attached", {
      stepId: `debug_runtime:${taskId}`,
      status: "completed",
      actor: "system",
      message: "Runtime debug log",
      debugRuntime: true,
      evidenceRefs: [makeEvidenceRef(entry.line)],
      legacyType: "log",
    });
  });

  emit("timeline_step_started", {
    stepId: "debug:session",
    status: "in_progress",
    actor: "system",
    message: "Debug session: runtime collector ready",
    debugPhase: "instrument" satisfies DebugPhase,
    groupId: "stage:debug",
    ingestUrl,
    phases: DEBUG_PHASE_ORDER,
  });

  emit("timeline_evidence_attached", {
    stepId: `debug_ingest:${taskId}`,
    status: "completed",
    actor: "system",
    message:
      "Debug ingest endpoint (POST JSON or text). Instrument code to send logs here during reproduction.",
    debugIngestUrl: true,
    evidenceRefs: [
      {
        evidenceId: `debug_ingest:${taskId}`,
        sourceType: "other",
        sourceUrlOrPath: ingestUrl,
        snippet: "POST runtime logs to this URL while reproducing the issue.",
        capturedAt: Date.now(),
      },
    ],
    legacyType: "log",
  });

  return { ingestUrl };
}

export function endDebugModeSession(taskId: string): void {
  closeDebugRuntimeSession(taskId);
}
