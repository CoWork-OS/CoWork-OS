import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2 } from "lucide-react";
import type { AgentThought, AgentTeamRunPhase, AgentRole } from "../../shared/types";
import { getEmojiIcon } from "../utils/emoji-icon-map";

interface CollaborativeThoughtsPanelProps {
  teamRunId: string;
  teamId: string;
  runPhase?: AgentTeamRunPhase;
  onClose?: () => void;
  mode?: "collaborative" | "multi-llm";
  isRunning?: boolean;
  onWrapUp?: () => void;
  isWrappingUp?: boolean;
}

interface TeamMemberInfo {
  role: AgentRole;
  isLeader: boolean;
}

const PHASE_LABELS: Record<string, string> = {
  dispatch: "Dispatching",
  think: "Thinking",
  synthesize: "Synthesizing",
  complete: "Complete",
};

const MULTI_LLM_PHASE_LABELS: Record<string, string> = {
  dispatch: "Distributing",
  think: "Analyzing",
  synthesize: "Judging",
  complete: "Complete",
};

const PHASE_ORDER: string[] = ["dispatch", "think", "synthesize", "complete"];
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

function PhaseIndicator({ phase, labels }: { phase: string; labels?: Record<string, string> }) {
  const currentIndex = PHASE_ORDER.indexOf(phase);
  const effectiveLabels = labels || PHASE_LABELS;
  return (
    <div className="phase-indicator">
      {PHASE_ORDER.map((p, i) => (
        <div key={p} className="phase-step-wrapper">
          <div
            className={`phase-step ${i < currentIndex ? "phase-completed" : ""} ${i === currentIndex ? "phase-active" : ""}`}
          >
            <span className="phase-dot" />
            <span className="phase-label">{effectiveLabels[p] || p}</span>
          </div>
          {i < PHASE_ORDER.length - 1 && (
            <div
              className={`phase-connector ${i < currentIndex ? "phase-connector-active" : ""}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function ThoughtBubble({ thought }: { thought: AgentThought }) {
  const [expanded, setExpanded] = useState(false);
  const content = thought.content;
  const isLong = content.length > 600;
  const displayContent = isLong && !expanded ? content.slice(0, 600) + "..." : content;

  const time = new Date(thought.createdAt);
  const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={`thought-bubble ${thought.isStreaming ? "thought-streaming" : ""}`}>
      <div className="thought-content markdown-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrlTransform}>
          {displayContent}
        </ReactMarkdown>
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

export function CollaborativeThoughtsPanel({
  teamRunId,
  teamId,
  runPhase,
  onClose,
  mode = "collaborative",
  isRunning,
  onWrapUp,
  isWrappingUp,
}: CollaborativeThoughtsPanelProps) {
  const isMultiLlm = mode === "multi-llm";
  const [thoughts, setThoughts] = useState<AgentThought[]>([]);
  const [streamingThoughts, setStreamingThoughts] = useState<Map<string, AgentThought>>(new Map());
  const [phase, setPhase] = useState<string>(runPhase || "dispatch");
  const [leaderAgentRoleId, setLeaderAgentRoleId] = useState<string | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMemberInfo[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Load team members and agent roles (skip for multi-LLM, derived from thoughts)
  useEffect(() => {
    if (!teamId || isMultiLlm) return;
    Promise.all([
      window.electronAPI.listTeamMembers(teamId),
      window.electronAPI.getAgentRoles(false),
    ])
      .then(([members, roles]: [any[], any[]]) => {
        const roleMap = new Map<string, AgentRole>();
        for (const r of roles) roleMap.set(r.id, r as AgentRole);

        const infos: TeamMemberInfo[] = members
          .sort((a: any, b: any) => a.memberOrder - b.memberOrder)
          .map((m: any) => ({
            role: roleMap.get(m.agentRoleId),
            isLeader: false,
          }))
          .filter((info: any) => info.role != null) as TeamMemberInfo[];

        setTeamMembers(infos);
      })
      .catch(() => {});
  }, [teamId, isMultiLlm]);

  // Load initial thoughts
  useEffect(() => {
    window.electronAPI
      .listTeamThoughts(teamRunId)
      .then((loaded: AgentThought[]) => {
        setThoughts(loaded);
        const leader = loaded.find((t) => t.phase === "dispatch" || t.phase === "synthesis");
        if (leader) setLeaderAgentRoleId(leader.agentRoleId);
      })
      .catch(() => {});
  }, [teamRunId]);

  // Subscribe to real-time thought events
  useEffect(() => {
    const unsubThought = window.electronAPI.onTeamThoughtEvent((event: any) => {
      if (event.runId !== teamRunId) return;
      if (event.type === "team_thought_added" && event.thought) {
        const t = event.thought as AgentThought;
        setThoughts((prev) => [...prev, t]);
        // Remove streaming placeholder for this agent now that we have real content
        setStreamingThoughts((prev) => {
          if (!prev.has(t.agentRoleId)) return prev;
          const next = new Map(prev);
          next.delete(t.agentRoleId);
          return next;
        });
        if (t.phase === "dispatch" || t.phase === "synthesis") {
          setLeaderAgentRoleId(t.agentRoleId);
        }
      } else if (event.type === "team_thought_updated" && event.thought) {
        const updated = event.thought as AgentThought;
        setThoughts((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      } else if (event.type === "team_thought_streaming" && event.thought) {
        // Ephemeral streaming progress — update per-agent streaming indicator
        const st = event.thought as AgentThought;
        setStreamingThoughts((prev) => {
          const next = new Map(prev);
          next.set(st.agentRoleId, st);
          return next;
        });
      }
    });

    const unsubRun = window.electronAPI.onTeamRunEvent((event: any) => {
      if (event.run?.id === teamRunId && event.run?.phase) {
        setPhase(event.run.phase);
      }
    });

    return () => {
      unsubThought();
      unsubRun();
    };
  }, [teamRunId]);

  // Sync external phase updates
  useEffect(() => {
    if (runPhase) setPhase(runPhase);
  }, [runPhase]);

  // Auto-scroll: find the nearest scrollable ancestor (main-body) for stick-to-bottom detection
  useEffect(() => {
    const panel = scrollRef.current;
    if (!panel) return;

    // Walk up to find the scrollable ancestor
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

  // Scroll the bottom sentinel into view when new thoughts or streaming updates arrive
  useEffect(() => {
    if (stickToBottomRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [thoughts, streamingThoughts]);

  // Resolve leader status on team members
  const resolvedTeamMembers = useMemo(() => {
    if (teamMembers.length === 0) return [];
    return teamMembers.map((m) => ({
      ...m,
      isLeader: m.role.id === leaderAgentRoleId,
    }));
  }, [teamMembers, leaderAgentRoleId]);

  // For multi-LLM mode: derive participant chips from thoughts AND streaming indicators
  const multiLlmParticipants = useMemo(() => {
    if (!isMultiLlm) return [];
    const seen = new Map<string, AgentThought>();
    // Include streaming thoughts first so chips appear immediately
    for (const [, st] of streamingThoughts) {
      if (!seen.has(st.agentRoleId)) {
        seen.set(st.agentRoleId, st);
      }
    }
    // Override with real thoughts when available
    for (const t of thoughts) {
      if (!seen.has(t.agentRoleId)) {
        seen.set(t.agentRoleId, t);
      }
    }
    return Array.from(seen.values());
  }, [isMultiLlm, thoughts, streamingThoughts]);

  return (
    <div className="collaborative-thoughts-panel" ref={scrollRef}>
      <div className="thoughts-header">
        <span className="thoughts-title">
          {isMultiLlm ? "Multi-LLM Mode" : "Collaborative Mode"}
        </span>
        {onClose && (
          <button className="thoughts-close-btn" onClick={onClose} title="Close">
            &times;
          </button>
        )}
      </div>

      {/* Team Announcement (collaborative mode) */}
      {!isMultiLlm && resolvedTeamMembers.length > 0 && (
        <div className="team-announcement">
          <div className="team-announcement-text">
            This task is being analyzed by a team of {resolvedTeamMembers.length} agents
          </div>
          <div className="team-members-grid">
            {resolvedTeamMembers.map((m) => (
              <div
                key={m.role.id}
                className={`team-member-chip ${m.isLeader ? "team-member-leader" : ""}`}
                style={{ borderColor: m.role.color }}
              >
                <span className="team-member-icon">
                  {(() => {
                    const Icon = getEmojiIcon(m.role.icon);
                    return Icon ? <Icon size={16} strokeWidth={1.5} /> : m.role.icon;
                  })()}
                </span>
                <span className="team-member-name" style={{ color: m.role.color }}>
                  {m.role.displayName}
                </span>
                {m.isLeader && <span className="leader-badge">Lead</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Multi-LLM Participant chips (derived from thoughts) */}
      {isMultiLlm && multiLlmParticipants.length > 0 && (
        <div className="team-announcement">
          <div className="team-announcement-text">
            Comparing {multiLlmParticipants.length} LLM models
          </div>
          <div className="team-members-grid">
            {multiLlmParticipants.map((t) => (
              <div
                key={t.agentRoleId}
                className={`team-member-chip ${t.agentRoleId === leaderAgentRoleId ? "team-member-leader" : ""}`}
                style={{ borderColor: t.agentColor }}
              >
                <span className="team-member-icon">
                  {(() => {
                    const Icon = getEmojiIcon(t.agentIcon);
                    return Icon ? <Icon size={16} strokeWidth={1.5} /> : t.agentIcon;
                  })()}
                </span>
                <span className="team-member-name" style={{ color: t.agentColor }}>
                  {t.agentDisplayName}
                </span>
                {t.agentRoleId === leaderAgentRoleId && <span className="leader-badge">Judge</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <PhaseIndicator phase={phase} labels={isMultiLlm ? MULTI_LLM_PHASE_LABELS : undefined} />

      <div className="thoughts-stream">
        {thoughts.length === 0 && streamingThoughts.size === 0 && (
          <div className="thoughts-empty">
            {phase === "dispatch"
              ? isMultiLlm
                ? "Distributing task to LLM providers..."
                : "Assembling team and dispatching tasks..."
              : isMultiLlm
                ? "Waiting for model outputs..."
                : "Waiting for agent thoughts..."}
          </div>
        )}

        {/* Live streaming indicators from active models/agents */}
        {streamingThoughts.size > 0 && thoughts.length === 0 && (
          <div className="streaming-thoughts-section">
            {Array.from(streamingThoughts.values()).map((st) => (
              <div key={st.agentRoleId} className="streaming-thought-entry">
                <div className="stream-agent-header">
                  <span className="stream-agent-icon">
                    {(() => {
                      const Icon = getEmojiIcon(st.agentIcon);
                      return Icon ? <Icon size={16} strokeWidth={1.5} /> : st.agentIcon;
                    })()}
                  </span>
                  <span className="stream-agent-name" style={{ color: st.agentColor }}>
                    {st.agentDisplayName}
                  </span>
                </div>
                <div
                  className="stream-thought thought-streaming"
                  style={{ borderLeftColor: st.agentColor }}
                >
                  <div className="thought-bubble thought-streaming">
                    <div className="thought-content streaming-progress">
                      <Loader2 className="streaming-spinner" size={14} strokeWidth={2} />
                      <span>{st.content}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {thoughts.map((thought, i) => {
          const prevThought = i > 0 ? thoughts[i - 1] : null;
          const showHeader = !prevThought || prevThought.agentRoleId !== thought.agentRoleId;
          // Check if this agent still has an active streaming indicator (show below real thoughts)
          const isLastForAgent =
            i === thoughts.length - 1 ||
            thoughts[i + 1]?.agentRoleId !== thought.agentRoleId;
          const agentStillStreaming = isLastForAgent && streamingThoughts.has(thought.agentRoleId);

          return (
            <div key={thought.id}>
              {showHeader && (
                <div className="stream-agent-header">
                  <span className="stream-agent-icon">
                    {(() => {
                      const Icon = getEmojiIcon(thought.agentIcon);
                      return Icon ? <Icon size={16} strokeWidth={1.5} /> : thought.agentIcon;
                    })()}
                  </span>
                  <span className="stream-agent-name" style={{ color: thought.agentColor }}>
                    {thought.agentDisplayName}
                  </span>
                  {thought.agentRoleId === leaderAgentRoleId && (
                    <span className="leader-badge">{isMultiLlm ? "Judge" : "Leader"}</span>
                  )}
                </div>
              )}
              <div
                className={`stream-thought ${thought.isStreaming ? "thought-streaming" : ""}`}
                style={{ borderLeftColor: thought.agentColor }}
              >
                <ThoughtBubble thought={thought} />
              </div>
              {agentStillStreaming && (
                <div
                  className="stream-thought thought-streaming"
                  style={{ borderLeftColor: thought.agentColor }}
                >
                  <div className="thought-bubble thought-streaming">
                    <div className="thought-content streaming-progress">
                      <Loader2 className="streaming-spinner" size={14} strokeWidth={2} />
                      <span>{streamingThoughts.get(thought.agentRoleId)?.content}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Streaming indicators for agents that haven't emitted any real thoughts yet */}
        {thoughts.length > 0 && streamingThoughts.size > 0 && (() => {
          const agentsWithThoughts = new Set(thoughts.map((t) => t.agentRoleId));
          const pendingAgents = Array.from(streamingThoughts.values()).filter(
            (st) => !agentsWithThoughts.has(st.agentRoleId),
          );
          if (pendingAgents.length === 0) return null;
          return pendingAgents.map((st) => (
            <div key={st.agentRoleId} className="streaming-thought-entry">
              <div className="stream-agent-header">
                <span className="stream-agent-icon">
                  {(() => {
                    const Icon = getEmojiIcon(st.agentIcon);
                    return Icon ? <Icon size={16} strokeWidth={1.5} /> : st.agentIcon;
                  })()}
                </span>
                <span className="stream-agent-name" style={{ color: st.agentColor }}>
                  {st.agentDisplayName}
                </span>
              </div>
              <div
                className="stream-thought thought-streaming"
                style={{ borderLeftColor: st.agentColor }}
              >
                <div className="thought-bubble thought-streaming">
                  <div className="thought-content streaming-progress">
                    <Loader2 className="streaming-spinner" size={14} strokeWidth={2} />
                    <span>{st.content}</span>
                  </div>
                </div>
              </div>
            </div>
          ));
        })()}
      </div>

      {/* Phase status — sticky at bottom-left while running */}
      {isRunning && (
        <div className="collab-phase-status">
          <Loader2 className="collab-phase-spinner" size={14} strokeWidth={2.5} />
          <span className="collab-phase-label">
            {phase === "dispatch" &&
              (isMultiLlm ? "Distributing to LLM providers..." : "Assembling team...")}
            {phase === "think" &&
              (isMultiLlm ? "Models are analyzing..." : "Agents are working...")}
            {phase === "synthesize" &&
              (isMultiLlm ? "Judge is synthesizing..." : "Synthesizing insights...")}
            {phase === "complete" && "Complete"}
            {!phase &&
              (isMultiLlm ? "Starting multi-LLM run..." : "Starting collaborative run...")}
          </span>
          {(phase === "dispatch" || phase === "think") && onWrapUp && (
            <button
              className={`collab-wrap-up-btn${isWrappingUp ? " collab-wrap-up-active" : ""}`}
              onClick={() => {
                if (!isWrappingUp) onWrapUp();
              }}
              disabled={isWrappingUp}
              title={isWrappingUp ? "Wrapping up..." : "Skip remaining agents and synthesize now"}
            >
              {isWrappingUp ? "Wrapping up..." : "Wrap Up"}
            </button>
          )}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
