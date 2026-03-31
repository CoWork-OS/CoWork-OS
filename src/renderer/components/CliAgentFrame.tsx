import { useMemo, useState } from "react";
import { Check, X, Play, Loader2, ChevronDown, ChevronRight, Terminal, MessageSquare } from "lucide-react";
import { getEmojiIcon } from "../utils/emoji-icon-map";
import type { Task, TaskEvent } from "../../shared/types";
import type { CliAgentType } from "../../shared/cli-agent-detection";
import { getCliAgentDisplayInfo } from "../../shared/cli-agent-detection";
import { getEffectiveTaskEventType } from "../utils/task-event-compat";
import { sanitizeToolCallTextFromAssistant } from "../../shared/tool-call-text-sanitizer";
import { formatProviderErrorForDisplay } from "../../shared/provider-error-format";

interface CliAgentFrameProps {
  task: Task;
  events: TaskEvent[];
  agentType: CliAgentType;
  defaultExpanded?: boolean;
}

/** Event types worth showing in the CLI agent frame (checked against effective type) */
const DISPLAY_EVENT_TYPES = new Set([
  "assistant_message",
  "step_started",
  "progress_update",
  "step_completed",
  "step_failed",
  "plan_created",
  "task_completed",
  "task_cancelled",
  "error",
  "tool_call",
  "tool_result",
  "command_output",
]);

interface FrameEvent {
  id: string;
  type: string;
  icon: "play" | "check" | "x" | "loader" | "terminal" | "message";
  label: string;
  timestamp: number;
}

function classifyEvent(event: TaskEvent, agentName: string, task?: Task): FrameEvent | null {
  const effectiveType = getEffectiveTaskEventType(event);
  if (!DISPLAY_EVENT_TYPES.has(effectiveType)) return null;

  const p = event.payload as Record<string, unknown> | undefined;
  const step = p?.step as Record<string, unknown> | undefined;
  const sanitize = (value: unknown): string =>
    sanitizeToolCallTextFromAssistant(String(value || "")).text;

  switch (effectiveType) {
    case "step_started": {
      const desc = sanitize(step?.description || p?.description || "");
      const command = String(step?.command || "");
      // Detect specific patterns for better display
      if (command || desc.toLowerCase().includes("running") || desc.toLowerCase().includes("bash")) {
        return {
          id: event.id,
          type: effectiveType,
          icon: "terminal",
          label: command ? `Running: ${command}` : desc || "Running command...",
          timestamp: event.timestamp,
        };
      }
      const tool = String(step?.tool || p?.tool || "");
      if (tool.toLowerCase().includes("read") || tool.toLowerCase().includes("file")) {
        return {
          id: event.id,
          type: effectiveType,
          icon: "play",
          label: `Reading: ${sanitize(step?.path || p?.path || desc)}`,
          timestamp: event.timestamp,
        };
      }
      if (tool.toLowerCase().includes("write")) {
        return {
          id: event.id,
          type: effectiveType,
          icon: "play",
          label: `Writing: ${sanitize(step?.path || p?.path || desc)}`,
          timestamp: event.timestamp,
        };
      }
      if (tool.toLowerCase().includes("fetch") || tool.toLowerCase().includes("web")) {
        return {
          id: event.id,
          type: effectiveType,
          icon: "play",
          label: `Fetching: ${sanitize(step?.url || p?.url || desc)}`,
          timestamp: event.timestamp,
        };
      }
      return {
        id: event.id,
        type: effectiveType,
        icon: "play",
        label: desc || (tool ? `Running: ${tool}` : `${agentName} is working...`),
        timestamp: event.timestamp,
      };
    }
    case "tool_call": {
      const tool = String(p?.tool || p?.toolName || "");
      const toolLower = tool.toLowerCase();
      if (toolLower === "run_command" || toolLower === "bash") {
        const cmd = String(p?.command || (p?.input as Record<string, unknown>)?.command || "");
        return {
          id: event.id,
          type: effectiveType,
          icon: "terminal",
          label: cmd ? `Running: ${truncate(cmd, 100)}` : "Running command...",
          timestamp: event.timestamp,
        };
      }
      if (toolLower === "spawn_agent") {
        const title = String(p?.title || (p?.input as Record<string, unknown>)?.title || "sub-task");
        return {
          id: event.id,
          type: effectiveType,
          icon: "play",
          label: `Delegating: ${truncate(sanitize(title), 80)}`,
          timestamp: event.timestamp,
        };
      }
      if (toolLower.includes("read") || toolLower.includes("grep") || toolLower.includes("glob")) {
        const filePath = String(p?.path || (p?.input as Record<string, unknown>)?.path || (p?.input as Record<string, unknown>)?.pattern || "");
        return {
          id: event.id,
          type: effectiveType,
          icon: "play",
          label: filePath ? `Reading: ${sanitize(filePath)}` : `Reading files...`,
          timestamp: event.timestamp,
        };
      }
      if (toolLower.includes("write") || toolLower.includes("edit")) {
        const filePath = String(p?.path || (p?.input as Record<string, unknown>)?.file_path || "");
        return {
          id: event.id,
          type: effectiveType,
          icon: "play",
          label: filePath ? `Writing: ${sanitize(filePath)}` : `Writing...`,
          timestamp: event.timestamp,
        };
      }
      if (toolLower.includes("fetch") || toolLower.includes("web") || toolLower.includes("browse")) {
        const url = String(p?.url || (p?.input as Record<string, unknown>)?.url || "");
        return {
          id: event.id,
          type: effectiveType,
          icon: "play",
          label: url ? `Fetching: ${truncate(sanitize(url), 80)}` : `Fetching...`,
          timestamp: event.timestamp,
        };
      }
      return {
        id: event.id,
        type: effectiveType,
        icon: "play",
        label: `Running tool: ${tool || "unknown"}`,
        timestamp: event.timestamp,
      };
    }
    case "tool_result": {
      const tool = String(p?.tool || p?.toolName || "");
      const success = p?.success !== false && !p?.error;
      return {
        id: event.id,
        type: effectiveType,
        icon: success ? "check" : "x",
        label: success
          ? `Done: ${tool || "tool"}`
          : `Failed: ${tool || "tool"} — ${truncate(sanitize(p?.error || "error"), 80)}`,
        timestamp: event.timestamp,
      };
    }
    case "command_output": {
      // Only show the "start" type to avoid flooding with every stdout chunk
      const outputType = String(p?.type || "");
      if (outputType !== "start") return null;
      const cmd = String(p?.command || "");
      return {
        id: event.id,
        type: effectiveType,
        icon: "terminal",
        label: cmd ? `$ ${truncate(cmd, 100)}` : "Running command...",
        timestamp: event.timestamp,
      };
    }
    case "step_completed":
      {
        const completedLabel = sanitize(step?.description || p?.description || "step");
        return {
          id: event.id,
          type: effectiveType,
          icon: "check",
          label: !completedLabel || completedLabel.toLowerCase() === "step" ? "Done" : `Done: ${completedLabel}`,
          timestamp: event.timestamp,
        };
      }
    case "step_failed":
      {
        const failedLabel = sanitize(step?.description || p?.description || "step");
        const failureText = sanitize(
          formatProviderErrorForDisplay(String(p?.error || p?.reason || ""), { task }),
        );
        return {
          id: event.id,
          type: effectiveType,
          icon: "x",
          label:
            !failedLabel || failedLabel.toLowerCase() === "step"
              ? `Something failed${failureText ? ` — ${failureText}` : ""}`
              : `Failed: ${failedLabel}${failureText ? ` — ${failureText}` : ""}`,
          timestamp: event.timestamp,
        };
      }
    case "assistant_message":
      if (
        task?.resultSummary &&
        task.resultSummary.trim().length > 0 &&
        sanitize(p?.message).trim() === task.resultSummary.trim()
      ) {
        return null;
      }
      return {
        id: event.id,
        type: effectiveType,
        icon: "message",
        label: truncate(sanitize(p?.message) || `${agentName} sent an update`, 120),
        timestamp: event.timestamp,
      };
    case "progress_update":
      return {
        id: event.id,
        type: effectiveType,
        icon: "loader",
        label: sanitize(p?.message) || `${agentName} is working...`,
        timestamp: event.timestamp,
      };
    case "plan_created":
      return {
        id: event.id,
        type: effectiveType,
        icon: "play",
        label: "Plan created",
        timestamp: event.timestamp,
      };
    case "task_completed":
      return {
        id: event.id,
        type: effectiveType,
        icon: "check",
        label: "Task completed",
        timestamp: event.timestamp,
      };
    case "task_cancelled":
      return {
        id: event.id,
        type: effectiveType,
        icon: "x",
        label: "Task cancelled",
        timestamp: event.timestamp,
      };
    case "error":
      return {
        id: event.id,
        type: effectiveType,
        icon: "x",
        label: sanitize(
          formatProviderErrorForDisplay(String(p?.message || p?.error || "Error"), { task }),
        ),
        timestamp: event.timestamp,
      };
    default:
      return null;
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "…";
}

function formatDuration(startMs: number, endMs: number): string {
  const diffSec = Math.round((endMs - startMs) / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return `${mins}m ${secs}s`;
}

function EventIcon({ icon }: { icon: FrameEvent["icon"] }) {
  switch (icon) {
    case "play":
      return <Play size={13} strokeWidth={2} className="cli-event-icon cli-event-icon-play" />;
    case "check":
      return (
        <Check size={13} strokeWidth={2.5} className="cli-event-icon cli-event-icon-check" />
      );
    case "x":
      return <X size={13} strokeWidth={2.5} className="cli-event-icon cli-event-icon-x" />;
    case "loader":
      return (
        <Loader2 size={13} strokeWidth={2} className="cli-event-icon cli-event-icon-loader" />
      );
    case "terminal":
      return (
        <Terminal size={13} strokeWidth={2} className="cli-event-icon cli-event-icon-terminal" />
      );
    case "message":
      return <MessageSquare size={13} strokeWidth={2} className="cli-event-icon cli-event-icon-message" />;
  }
}

function StatusChip({ status }: { status: Task["status"] }) {
  const isTerminal =
    status === "completed" || status === "failed" || status === "cancelled";
  const isExecuting = status === "executing" || status === "planning";

  return (
    <span
      className={`cli-status-chip ${isTerminal ? (status === "completed" ? "cli-status-completed" : "cli-status-failed") : isExecuting ? "cli-status-executing" : "cli-status-pending"}`}
    >
      {isExecuting && <Loader2 size={11} strokeWidth={2.5} className="cli-status-spinner" />}
      {status === "completed" && <Check size={11} strokeWidth={2.5} />}
      {status === "failed" && <X size={11} strokeWidth={2.5} />}
      <span>{status === "executing" ? "Running" : status === "completed" ? "Done" : status === "failed" ? "Failed" : status === "cancelled" ? "Cancelled" : "Pending"}</span>
    </span>
  );
}

export function CliAgentFrame({ task, events, agentType, defaultExpanded }: CliAgentFrameProps) {
  const isTerminal =
    task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  const [expanded, setExpanded] = useState(defaultExpanded ?? !isTerminal);
  const displayInfo = getCliAgentDisplayInfo(agentType);
  const agentName = displayInfo.name;

  const frameEvents = useMemo<FrameEvent[]>(() => {
    const result: FrameEvent[] = [];
    for (const event of events) {
      const classified = classifyEvent(event, agentName, task);
      if (classified) result.push(classified);
    }
    return result;
  }, [agentName, events, task]);

  const duration = useMemo(() => {
    if (frameEvents.length === 0) return null;
    const start = frameEvents[0].timestamp;
    const end = isTerminal
      ? frameEvents[frameEvents.length - 1].timestamp
      : Date.now();
    return formatDuration(start, end);
  }, [frameEvents, isTerminal]);

  const firstEventTime = frameEvents.length > 0
    ? new Date(frameEvents[0].timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className={`cli-agent-frame ${task.status === "executing" ? "cli-agent-frame-executing" : ""} ${isTerminal ? `cli-agent-frame-${task.status}` : ""}`}
    >
      {/* Header */}
      <button className="cli-agent-frame-header" onClick={() => setExpanded(!expanded)}>
        <div className="cli-agent-frame-header-left">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="cli-agent-icon">
            {(() => {
              const Icon = getEmojiIcon(displayInfo.icon || "🤖");
              return <Icon size={14} strokeWidth={2} />;
            })()}
          </span>
          <span className="cli-agent-title">{task.title}</span>
          <span className="cli-badge" style={{ backgroundColor: displayInfo.color }}>
            {displayInfo.badge}
          </span>
        </div>
        <div className="cli-agent-frame-header-right">
          <StatusChip status={task.status} />
          {firstEventTime && <span className="cli-agent-time">{firstEventTime}</span>}
          {duration && <span className="cli-agent-duration">{duration}</span>}
        </div>
      </button>

      {/* Body — event list */}
      {expanded && (
        <div className="cli-agent-frame-body">
          {frameEvents.length === 0 ? (
            <div className="cli-event-row cli-event-empty">
              <Loader2 size={13} className="cli-event-icon cli-event-icon-loader" />
              <span>{agentName} is warming up...</span>
            </div>
          ) : (
            frameEvents.map((fe, idx) => {
              const time = new Date(fe.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });
              // Loader should only spin for the very last event while the task is still active;
              // past progress_update events and all loaders in terminal tasks render as static.
              const effectiveIcon: FrameEvent["icon"] =
                fe.icon === "loader" && (isTerminal || idx !== frameEvents.length - 1)
                  ? "message"
                  : fe.icon;
              return (
                <div
                  key={fe.id}
                  className={`cli-event-row ${fe.type === "step_failed" || fe.type === "error" ? "cli-event-error" : ""} ${fe.type === "step_completed" || fe.type === "task_completed" ? "cli-event-success" : ""}`}
                >
                  <EventIcon icon={effectiveIcon} />
                  <span className="cli-event-label">{fe.label}</span>
                  <span className="cli-event-time">{time}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
