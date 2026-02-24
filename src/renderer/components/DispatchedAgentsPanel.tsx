import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task, TaskEvent, EventType } from "../../shared/types";

interface AgentRoleInfo {
  id: string;
  displayName: string;
  icon: string;
  color: string;
}

interface DispatchedAgentsPanelProps {
  parentTaskId: string;
  childTasks: Task[];
  childEvents: TaskEvent[];
  onSelectChildTask?: (taskId: string) => void;
}

const SAFE_LINK_PROTOCOL_REGEX = /^(https?:|mailto:|tel:)/i;

function safeMarkdownUrlTransform(url: string): string {
  const normalized = url.trim();
  if (!normalized) return "";
  if (
    normalized.startsWith("#") ||
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../")
  ) {
    return normalized;
  }
  return SAFE_LINK_PROTOCOL_REGEX.test(normalized) ? normalized : "";
}

/** Display event types worth showing in the stream */
const DISPLAY_EVENT_TYPES = new Set<string>([
  "assistant_message",
  "step_started",
  "step_completed",
  "step_failed",
  "plan_created",
  "task_completed",
  "task_cancelled",
  "error",
]);

interface StreamItem {
  id: string;
  taskId: string;
  agentRoleId: string;
  agentIcon: string;
  agentColor: string;
  agentName: string;
  type: EventType;
  content: string;
  timestamp: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads are untyped
function formatEventContent(type: EventType, payload: TaskEvent["payload"]): string {
  const p = payload as Record<string, unknown> | undefined;
  const step = p?.step as Record<string, unknown> | undefined;
  const plan = p?.plan as Record<string, unknown> | undefined;
  switch (type) {
    case "assistant_message":
      return (p?.message as string) || "";
    case "step_started":
      return `Starting: ${(step?.description as string) || (p?.description as string) || "step"}`;
    case "step_completed":
      return `Completed: ${(step?.description as string) || (p?.description as string) || "step"}`;
    case "step_failed":
      return `Failed: ${(step?.description as string) || (p?.description as string) || "step"} — ${(p?.error as string) || ""}`;
    case "plan_created": {
      const steps = (plan?.steps as unknown[]) || (p?.steps as unknown[]) || [];
      return `Created plan with ${steps.length} step${steps.length !== 1 ? "s" : ""}`;
    }
    case "task_completed":
      return "Task completed successfully";
    case "task_cancelled":
      return "Task was cancelled";
    case "error":
      return (p?.message as string) || (p?.error as string) || "An error occurred";
    default:
      return "";
  }
}

function StreamBubble({ item }: { item: StreamItem }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = item.content.length > 600;
  const displayContent = isLong && !expanded ? item.content.slice(0, 600) + "..." : item.content;

  const time = new Date(item.timestamp);
  const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const isStep =
    item.type === "step_started" || item.type === "step_completed" || item.type === "step_failed";
  const isMarkdown = item.type === "assistant_message";

  return (
    <div className="thought-bubble">
      <div className="thought-content markdown-content">
        {isStep ? (
          <p
            className={`step-event ${item.type === "step_completed" ? "step-completed" : ""} ${item.type === "step_failed" ? "step-failed" : ""}`}
          >
            {item.type === "step_completed" && "✓ "}
            {item.type === "step_failed" && "✗ "}
            {item.type === "step_started" && "▸ "}
            {displayContent}
          </p>
        ) : isMarkdown ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrlTransform}>
            {displayContent}
          </ReactMarkdown>
        ) : (
          <p>{displayContent}</p>
        )}
      </div>
      <div className="thought-footer">
        <span className="thought-time">{timeStr}</span>
        {isLong && (
          <button className="thought-expand-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}

function DispatchPhaseIndicator({ childTasks }: { childTasks: Task[] }) {
  const allTerminal = childTasks.every(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
  );
  const anyWorking = childTasks.some((t) => t.status === "executing" || t.status === "planning");
  const phase = allTerminal ? "complete" : anyWorking ? "working" : "dispatched";

  const phases = ["dispatched", "working", "complete"];
  const labels: Record<string, string> = {
    dispatched: "Dispatched",
    working: "Working",
    complete: "Complete",
  };
  const currentIndex = phases.indexOf(phase);

  return (
    <div className="phase-indicator">
      {phases.map((p, i) => (
        <div key={p} className="phase-step-wrapper">
          <div
            className={`phase-step ${i < currentIndex ? "phase-completed" : ""} ${i === currentIndex ? "phase-active" : ""}`}
          >
            <span className="phase-dot" />
            <span className="phase-label">{labels[p]}</span>
          </div>
          {i < phases.length - 1 && (
            <div
              className={`phase-connector ${i < currentIndex ? "phase-connector-active" : ""}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function DispatchedAgentsPanel({
  parentTaskId: _parentTaskId,
  childTasks,
  childEvents,
  onSelectChildTask,
}: DispatchedAgentsPanelProps) {
  const [agentRoles, setAgentRoles] = useState<Map<string, AgentRoleInfo>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Load agent roles once
  useEffect(() => {
    window.electronAPI
      .getAgentRoles(false)
      .then((roles: AgentRoleInfo[]) => {
        const map = new Map<string, AgentRoleInfo>();
        for (const r of roles) {
          map.set(r.id, {
            id: r.id,
            displayName: r.displayName,
            icon: r.icon,
            color: r.color,
          });
        }
        setAgentRoles(map);
      })
      .catch(() => {});
  }, []);

  // Auto-scroll: detect scrollable ancestor
  useEffect(() => {
    const panel = scrollRef.current;
    if (!panel) return;
    let scrollParent: HTMLElement | null = panel.parentElement;
    while (scrollParent && scrollParent.scrollHeight <= scrollParent.clientHeight) {
      scrollParent = scrollParent.parentElement;
    }
    if (!scrollParent) return;

    const onScroll = () => {
      const remaining =
        scrollParent!.scrollHeight - scrollParent!.scrollTop - scrollParent!.clientHeight;
      stickToBottomRef.current = remaining <= 120;
    };
    onScroll();
    scrollParent.addEventListener("scroll", onScroll);
    return () => scrollParent!.removeEventListener("scroll", onScroll);
  }, []);

  // Scroll to bottom when new events arrive
  useEffect(() => {
    if (stickToBottomRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [childEvents]);

  // Resolve agent info per child task
  const agentInfos = useMemo(() => {
    return childTasks.map((task) => {
      const role = task.assignedAgentRoleId ? agentRoles.get(task.assignedAgentRoleId) : undefined;
      return {
        task,
        role,
        status: task.status,
      };
    });
  }, [childTasks, agentRoles]);

  // Build the event stream
  const streamItems = useMemo(() => {
    const items: StreamItem[] = [];
    for (const event of childEvents) {
      if (!DISPLAY_EVENT_TYPES.has(event.type)) continue;
      const task = childTasks.find((t) => t.id === event.taskId);
      if (!task) continue;
      const role = task.assignedAgentRoleId ? agentRoles.get(task.assignedAgentRoleId) : undefined;

      const content = formatEventContent(event.type, event.payload);
      if (!content) continue;

      items.push({
        id: event.id || `${event.taskId}-${event.timestamp}`,
        taskId: event.taskId,
        agentRoleId: task.assignedAgentRoleId || "unknown",
        agentIcon: role?.icon || "🤖",
        agentColor: role?.color || "#6366f1",
        agentName: role?.displayName || task.title.replace(/^@[^:]+:\s*/, ""),
        type: event.type,
        content,
        timestamp: event.timestamp,
      });
    }
    return items;
  }, [childEvents, childTasks, agentRoles]);

  const workingCount = childTasks.filter(
    (t) => t.status === "executing" || t.status === "planning",
  ).length;

  return (
    <div className="dispatched-agents-panel" ref={scrollRef}>
      <div className="thoughts-header">
        <span className="thoughts-title">Dispatched Agents ({childTasks.length})</span>
      </div>

      {/* Agent chips */}
      <div className="team-announcement">
        <div className="team-announcement-text">
          {childTasks.length} agent{childTasks.length !== 1 ? "s" : ""} working on sub-tasks
        </div>
        <div className="team-members-grid">
          {agentInfos.map((info) => (
            <div
              key={info.task.id}
              className="team-member-chip"
              style={{
                borderColor: info.role?.color || "#6366f1",
                cursor: onSelectChildTask ? "pointer" : undefined,
              }}
              onClick={() => onSelectChildTask?.(info.task.id)}
              title={`Click to view ${info.role?.displayName || "agent"}'s task`}
            >
              <span className="team-member-icon">{info.role?.icon || "🤖"}</span>
              <span className="team-member-name" style={{ color: info.role?.color || "#6366f1" }}>
                {info.role?.displayName || "Agent"}
              </span>
              <span className={`dispatched-agent-status status-${info.status}`}>
                {info.status === "executing"
                  ? "working"
                  : info.status === "planning"
                    ? "planning"
                    : info.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      <DispatchPhaseIndicator childTasks={childTasks} />

      {/* Event stream */}
      <div className="thoughts-stream">
        {streamItems.length === 0 && (
          <div className="thoughts-empty">Dispatching agents and waiting for results...</div>
        )}
        {streamItems.map((item, i) => {
          const prev = i > 0 ? streamItems[i - 1] : null;
          const showHeader = !prev || prev.agentRoleId !== item.agentRoleId;

          return (
            <div key={item.id}>
              {showHeader && (
                <div className="stream-agent-header">
                  <span className="stream-agent-icon">{item.agentIcon}</span>
                  <span className="stream-agent-name" style={{ color: item.agentColor }}>
                    {item.agentName}
                  </span>
                </div>
              )}
              <div className="stream-thought" style={{ borderLeftColor: item.agentColor }}>
                <StreamBubble item={item} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Sticky status bar */}
      {workingCount > 0 && (
        <div className="collab-phase-status">
          <svg
            className="collab-phase-spinner"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <path d="M12 2a10 10 0 0 1 10 10" />
          </svg>
          <span className="collab-phase-label">
            {workingCount} agent{workingCount !== 1 ? "s" : ""} working...
          </span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
