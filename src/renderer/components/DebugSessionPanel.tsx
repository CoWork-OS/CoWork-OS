import { useMemo } from "react";
import { Bug } from "lucide-react";
import type { TaskEvent } from "../../shared/types";
import { DEBUG_PHASE_ORDER, type DebugPhase } from "../../shared/debug-mode";

function isDebugPhase(value: unknown): value is DebugPhase {
  return typeof value === "string" && (DEBUG_PHASE_ORDER as readonly string[]).includes(value);
}

export interface DebugSessionPanelProps {
  events: TaskEvent[];
}

/**
 * Summary strip for tasks created in Debug execution mode: phase, ingest URL, loop stages.
 */
export function DebugSessionPanel({ events }: DebugSessionPanelProps) {
  const { ingestUrl, activePhase, lastRuntimeTrace, lastPromptStack, lastConsolidation, lastSessionFork } =
    useMemo(() => {
    let ingest: string | null = null;
    let phase: DebugPhase = "hypothesize";
    let phaseFound = false;
    let runtimeTrace: { tool: string; decision: string; status: string } | null = null;
    let promptStack: { memoryIndexInjected: boolean; topicCount: number } | null = null;
    let consolidation: { topicCount?: number; skipped?: boolean } | null = null;
    let sessionFork: { sourceTaskId?: string; branchLabel?: string } | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const payload = e.payload as Record<string, unknown> | undefined;
      if (!ingest && e.type === "timeline_evidence_attached" && payload?.debugIngestUrl) {
        const refs = payload.evidenceRefs;
        if (Array.isArray(refs) && refs[0] && typeof (refs[0] as { sourceUrlOrPath?: string }).sourceUrlOrPath === "string") {
          ingest = (refs[0] as { sourceUrlOrPath: string }).sourceUrlOrPath;
        }
      }
      if (!phaseFound && e.type === "timeline_step_started" && payload?.debugPhase && isDebugPhase(payload.debugPhase)) {
        phase = payload.debugPhase;
        phaseFound = true;
      }
      if (
        !runtimeTrace &&
        e.type === "log" &&
        payload?.metric === "tool_runtime_trace" &&
        typeof payload?.tool === "string"
      ) {
        const envelope =
          payload.envelope && typeof payload.envelope === "object"
            ? (payload.envelope as Record<string, unknown>)
            : null;
        const trace =
          payload.policyTrace && typeof payload.policyTrace === "object"
            ? (payload.policyTrace as Record<string, unknown>)
            : null;
        runtimeTrace = {
          tool: payload.tool,
          decision: typeof trace?.finalDecision === "string" ? trace.finalDecision : "allow",
          status: typeof envelope?.status === "string" ? envelope.status : "unknown",
        };
      }
      if (
        !promptStack &&
        e.type === "log" &&
        payload?.message === "Prompt stack built"
      ) {
        promptStack = {
          memoryIndexInjected: payload?.memoryIndexInjected === true,
          topicCount: typeof payload?.topicCount === "number" ? payload.topicCount : 0,
        };
      }
      if (
        !consolidation &&
        e.type === "log" &&
        typeof payload?.consolidation === "object" &&
        payload?.message &&
        String(payload.message).includes("Memory consolidation")
      ) {
        const result = payload.consolidation as Record<string, unknown>;
        consolidation = {
          topicCount: typeof result.topicCount === "number" ? result.topicCount : undefined,
          skipped: result.skipped === true,
        };
      }
      if (
        !sessionFork &&
        e.type === "log" &&
        payload?.message === "Session fork created"
      ) {
        sessionFork = {
          sourceTaskId:
            typeof payload?.sourceTaskId === "string" ? payload.sourceTaskId : undefined,
          branchLabel: typeof payload?.branchLabel === "string" ? payload.branchLabel : undefined,
        };
      }
      if (ingest && phaseFound && runtimeTrace && promptStack && consolidation && sessionFork) {
        break;
      }
    }
    return {
      ingestUrl: ingest,
      activePhase: phase,
      lastRuntimeTrace: runtimeTrace,
      lastPromptStack: promptStack,
      lastConsolidation: consolidation,
      lastSessionFork: sessionFork,
    };
  }, [events]);

  return (
    <div
      className="debug-session-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        marginBottom: 12,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--color-border-subtle, rgba(0,0,0,0.08))",
        background: "var(--color-bg-elevated, rgba(99, 102, 241, 0.06))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: "0.8rem" }}>
        <Bug size={16} strokeWidth={2} aria-hidden />
        <span>Debug mode</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: "0.72rem",
            fontWeight: 500,
            color: "var(--color-text-muted, #6b7280)",
          }}
        >
          Phase: {activePhase}
        </span>
      </div>
      <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted, #6b7280)", lineHeight: 1.45 }}>
        Hypothesize → instrument → reproduce → analyze logs → targeted fix → verify → remove{" "}
        <code style={{ fontSize: "0.7rem" }}>cowork-debug</code> markers. Use structured prompts when the agent asks
        you to reproduce or confirm.
      </div>
      {ingestUrl ? (
        <div style={{ fontSize: "0.72rem" }}>
          <span style={{ fontWeight: 600 }}>Runtime ingest: </span>
          <code
            style={{
              wordBreak: "break-all",
              fontSize: "0.68rem",
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--color-bg-muted, rgba(0,0,0,0.04))",
            }}
          >
            {ingestUrl}
          </code>
        </div>
      ) : (
        <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted, #6b7280)" }}>
          Starting debug runtime collector…
        </div>
      )}
      <div style={{ fontSize: "0.68rem", color: "var(--color-text-muted, #8b8fa3)" }}>
        Stages: {DEBUG_PHASE_ORDER.join(" → ")}
      </div>
      {lastRuntimeTrace ? (
        <div style={{ fontSize: "0.68rem", color: "var(--color-text-muted, #8b8fa3)" }}>
          Runtime: <code>{lastRuntimeTrace.tool}</code> · decision {lastRuntimeTrace.decision} · status{" "}
          {lastRuntimeTrace.status}
        </div>
      ) : null}
      {lastPromptStack ? (
        <div style={{ fontSize: "0.68rem", color: "var(--color-text-muted, #8b8fa3)" }}>
          Prompt stack: memory index {lastPromptStack.memoryIndexInjected ? "on" : "off"} · topics{" "}
          {lastPromptStack.topicCount}
        </div>
      ) : null}
      {lastConsolidation ? (
        <div style={{ fontSize: "0.68rem", color: "var(--color-text-muted, #8b8fa3)" }}>
          Consolidation: {lastConsolidation.skipped ? "skipped" : "completed"} · topics{" "}
          {lastConsolidation.topicCount ?? 0}
        </div>
      ) : null}
      {lastSessionFork ? (
        <div style={{ fontSize: "0.68rem", color: "var(--color-text-muted, #8b8fa3)" }}>
          Session fork: {lastSessionFork.branchLabel || "unnamed"} from{" "}
          <code>{lastSessionFork.sourceTaskId || "unknown"}</code>
        </div>
      ) : null}
    </div>
  );
}
