/**
 * CollaborativeSummaryPanel
 *
 * Chronological timeline view for collaborative runs. Shows strategic plan,
 * spawning steps, progress thoughts, and status updates in order — not just
 * the final result.
 */

import { useEffect, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Loader2, ChevronDown, Check } from "lucide-react";
import type { Task, AgentTeamRun, AgentThought, AgentTeamItem } from "../../shared/types";
import type { TaskEvent } from "../../shared/types";
import { SYNTHESIS_TASK_TITLE, isSynthesisChildTask } from "../../shared/synthesis-agent-detection";
import { getEffectiveTaskEventType } from "../utils/task-event-compat";
import { normalizeMarkdownForCollab, fixUnclosedBold } from "../utils/markdown-inline-lists";
import { replaceEmojisInChildren, stripLeadingEmoji } from "../utils/emoji-replacer";
import { getEmojiIcon } from "../utils/emoji-icon-map";

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen).trim() + "...";
}

type TimelineEntry =
  | { kind: "strategic"; id: string; content: string; ts: number }
  | { kind: "spawn_header"; id: string; count: number; ts: number }
  | { kind: "spawn"; id: string; title: string; description: string; taskId: string | null; icon?: string; ts: number }
  | { kind: "status"; id: string; label: string; ts: number }
  | { kind: "thought"; id: string; thought: AgentThought; ts: number };

interface CollaborativeSummaryPanelProps {
  collaborativeRun: AgentTeamRun;
  childTasks: Task[];
  childEvents?: TaskEvent[];
  userPrompt?: string;
  onSelectChildTask?: (taskId: string) => void;
  onWrapUp?: () => void;
  isWrappingUp?: boolean;
  /** When true, main task is done — hide Wrap Up */
  mainTaskCompleted?: boolean;
}

export function CollaborativeSummaryPanel({
  collaborativeRun,
  childTasks,
  childEvents = [],
  userPrompt,
  onSelectChildTask,
  onWrapUp,
  isWrappingUp,
  mainTaskCompleted = false,
}: CollaborativeSummaryPanelProps) {
  const [teamItems, setTeamItems] = useState<AgentTeamItem[]>([]);
  const [thoughts, setThoughts] = useState<AgentThought[]>([]);
  const [phase, setPhase] = useState<string>(collaborativeRun.phase || "dispatch");
  const [spawnEvents, setSpawnEvents] = useState<Array<{ item: AgentTeamItem; ts: number }>>([]);
  const [expanded, setExpanded] = useState(true);
  const [agentRoles, setAgentRoles] = useState<Map<string, { icon?: string }>>(new Map());

  useEffect(() => {
    window.electronAPI
      .listTeamItems(collaborativeRun.id)
      .then((items: AgentTeamItem[]) => {
        setTeamItems(items);
        // Seed spawn events from items with sourceTaskId (when we load after spawns already happened)
        // Use createdAt (spawn time), not updatedAt (last-modified time), to preserve creation order.
        setSpawnEvents((prev) => {
          if (prev.length > 0) return prev;
          return items
            .filter((i) => i.sourceTaskId)
            .map((i) => ({ item: i, ts: i.createdAt ?? i.updatedAt }))
            .sort((a, b) => a.ts - b.ts);
        });
      })
      .catch(() => {});
  }, [collaborativeRun.id]);

  useEffect(() => {
    window.electronAPI
      .listTeamThoughts(collaborativeRun.id)
      .then((loaded: AgentThought[]) => setThoughts(loaded))
      .catch(() => {});
  }, [collaborativeRun.id]);

  useEffect(() => {
    const unsubThought = window.electronAPI.onTeamThoughtEvent(
      (event: { runId: string; type: string; thought?: AgentThought }) => {
        if (event.runId !== collaborativeRun.id) return;
        if (event.type === "team_thought_added" && event.thought) {
          setThoughts((prev) => [...prev, event.thought!]);
        }
      },
    );
    const unsubRun = window.electronAPI.onTeamRunEvent(
      (event: {
        runId?: string;
        type?: string;
        run?: { id: string; phase?: string };
        item?: AgentTeamItem;
        timestamp?: number;
      }) => {
        if (event.run?.id === collaborativeRun.id && event.run?.phase) {
          setPhase(event.run.phase);
        }
        if (event.type === "team_item_spawned" && event.item && event.runId === collaborativeRun.id) {
          setSpawnEvents((prev) => {
            const ts = (event as { timestamp?: number }).timestamp ?? Date.now();
            if (prev.some((e) => e.item.id === event.item!.id)) return prev;
            return [...prev, { item: event.item!, ts }];
          });
        }
      },
    );
    return () => {
      if (typeof unsubThought === "function") unsubThought();
      if (typeof unsubRun === "function") unsubRun();
    };
  }, [collaborativeRun.id]);

  useEffect(() => {
    window.electronAPI
      .getAgentRoles(false)
      .then((roles: Array<{ id: string; icon?: string }>) => {
        const map = new Map<string, { icon?: string }>();
        for (const r of roles) map.set(r.id, { icon: r.icon });
        setAgentRoles(map);
      })
      .catch(() => {});
  }, []);

  const childByTaskId = new Map(childTasks.map((t) => [t.id, t]));
  const taskToRoleId = new Map<string, string>();
  for (const item of teamItems) {
    if (item.sourceTaskId && item.ownerAgentRoleId) taskToRoleId.set(item.sourceTaskId, item.ownerAgentRoleId);
  }
  const spawnItems = teamItems.map((item) => {
    const childTask = item.sourceTaskId ? childByTaskId.get(item.sourceTaskId) : null;
    return {
      id: item.id,
      title: item.title,
      description: item.description || childTask?.prompt || "",
      taskId: item.sourceTaskId || null,
      // Use createdAt (spawn time) for ordering, not updatedAt (last-modified time)
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  const displayItems =
    spawnItems.length > 0
      ? spawnItems
      : childTasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.prompt || "",
          taskId: t.id,
          updatedAt: t.updatedAt ?? t.createdAt ?? 0,
        }));

  const completedCount = childTasks.filter(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
  ).length;
  const workingCount = childTasks.filter(
    (t) => t.status === "executing" || t.status === "planning" || t.status === "interrupted",
  ).length;
  const allDone = completedCount === childTasks.length && childTasks.length > 0;

  // Build chronological timeline
  const timeline = useMemo(() => {
    const entries: TimelineEntry[] = [];
    const runStart = collaborativeRun.startedAt ?? 0;

    // 1. Strategic intro (from first dispatch thought or generated)
    const strategicThought = thoughts.find(
      (t) =>
        t.phase === "dispatch" &&
        t.content.length > 40 &&
        /^(I'm|I'll|We're|Splitting|Dividing|Coordinating|Creating)/i.test(t.content.trim()),
    );
    if (strategicThought) {
      entries.push({
        kind: "strategic",
        id: `strategic-${strategicThought.id}`,
        content: strategicThought.content,
        ts: strategicThought.createdAt,
      });
    } else if (userPrompt && displayItems.length > 0) {
      entries.push({
        kind: "strategic",
        id: "strategic-generated",
        content: `Coordinating ${displayItems.length} agents to ${truncate(userPrompt, 80)}.`,
        ts: runStart,
      });
    }

    // 2 & 3. Spawn header and items — use child task createdAt when available (actual spawn time)
    const childByTaskId = new Map(childTasks.map((t) => [t.id, t]));
    const spawnOrder = displayItems
      .map((d) => {
        const childTask = d.taskId ? childByTaskId.get(d.taskId) : null;
        const roleId = childTask?.assignedAgentRoleId ?? (d.taskId ? taskToRoleId.get(d.taskId) : undefined);
        const role = roleId ? agentRoles.get(roleId) : undefined;
        const ts =
          spawnEvents.length > 0
            ? spawnEvents.find((e) => e.item.id === d.id || e.item.sourceTaskId === d.taskId)?.ts
            : childTask?.createdAt ?? childTask?.updatedAt ?? (d as { createdAt?: number }).createdAt ?? d.updatedAt;
        return {
          id: d.id,
          title: d.title,
          description: d.description,
          taskId: d.taskId,
          icon: role?.icon,
          // Fall back to createdAt before updatedAt so ordering reflects spawn time, not last-modified
          ts: ts ?? (d as { createdAt?: number }).createdAt ?? d.updatedAt,
        };
      })
      .filter((s) => s.ts != null && s.ts > 0)
      .sort((a, b) => a.ts - b.ts);

    const spawnTs = spawnOrder.length > 0 ? Math.min(...spawnOrder.map((s) => s.ts)) : runStart;
    entries.push({
      kind: "spawn_header",
      id: "spawn-header",
      count: displayItems.length,
      ts: Math.max(0, spawnTs - 1),
    });

    for (const s of spawnOrder) {
      entries.push({
        kind: "spawn",
        id: `spawn-${s.id}`,
        title: s.title,
        description: s.description,
        taskId: s.taskId,
        icon: s.icon,
        ts: s.ts,
      });
    }

    // 4. Status: "Thinking..." (after spawns, when phase=think)
    if (phase === "think" || phase === "dispatch") {
      const thinkTs = spawnTs + 100;
      entries.push({
        kind: "status",
        id: "status-thinking",
        label: "Thinking...",
        ts: thinkTs,
      });
    }

    // 5. Thoughts (chronological)
    for (const t of thoughts) {
      if (t.phase === "synthesis" || t.content.length > 50) {
        entries.push({
          kind: "thought",
          id: t.id,
          thought: t,
          ts: t.createdAt,
        });
      }
    }

    // 6. Status: "Sub-agents working..." (when we have thoughts and agents running)
    if (workingCount > 0 && thoughts.length > 0) {
      const lastThoughtTs = thoughts.length > 0 ? Math.max(...thoughts.map((t) => t.createdAt)) : 0;
      if (!entries.some((e) => e.kind === "status" && e.id === "status-working")) {
        entries.push({
          kind: "status",
          id: "status-working",
          label: "Sub-agents working...",
          ts: lastThoughtTs + 1,
        });
      }
    }

    // 7. Status: "Synthesizing..." (when phase=synthesize)
    if (phase === "synthesize") {
      entries.push({
        kind: "status",
        id: "status-synthesize",
        label: "Synthesizing...",
        ts: Date.now(),
      });
    }

    // 8. Status: "All N agents completed" (when done)
    if (allDone) {
      entries.push({
        kind: "status",
        id: "status-complete",
        label: `All ${childTasks.length} agents completed`,
        ts: collaborativeRun.completedAt ?? Date.now(),
      });
    }

    return entries.sort((a, b) => a.ts - b.ts);
  }, [
    thoughts,
    displayItems,
    spawnEvents,
    teamItems,
    agentRoles,
    childTasks,
    phase,
    workingCount,
    allDone,
    userPrompt,
    collaborativeRun.startedAt,
    collaborativeRun.completedAt,
    childTasks.length,
  ]);

  const isErrorLike = (text: string) =>
    /unable|error|failed|cannot|no team member|not provided/i.test(text);

  return (
    <div className="collaborative-summary-panel">
      <button
        type="button"
        className="collab-summary-heading"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <ChevronDown
          className={`collab-summary-chevron ${expanded ? "expanded" : ""}`}
          size={18}
        />
        <span className="collab-summary-heading-text">
          {allDone ? "Completed" : "In progress"} — {displayItems.length} agent
          {displayItems.length !== 1 ? "s" : ""}
        </span>
        {allDone && <Check className="collab-summary-done-badge" size={18} strokeWidth={2.5} />}
      </button>

      {expanded && (
        <div className="collab-summary-timeline">
          {timeline.map((entry) => {
            if (entry.kind === "strategic") {
              return (
                <div key={entry.id} className="collab-timeline-strategic">
                  {entry.content}
                </div>
              );
            }
            if (entry.kind === "spawn_header") {
              return (
                <div key={entry.id} className="collab-timeline-spawn-header">
                  Spawning {entry.count} agent{entry.count !== 1 ? "s" : ""}
                </div>
              );
            }
            if (entry.kind === "spawn") {
              const SpawnIcon = getEmojiIcon(entry.icon || "🤖");
              return (
                <div key={entry.id} className="collab-timeline-spawn">
                  <span className="collab-timeline-spawn-icon">
                    <SpawnIcon size={14} strokeWidth={1.5} />
                  </span>
                  <span className="collab-timeline-spawn-body">
                    <span
                      className={`collab-timeline-spawn-name ${entry.title === SYNTHESIS_TASK_TITLE ? "collab-timeline-spawn-synthesis" : ""}`}
                      onClick={() =>
                        entry.taskId &&
                        entry.title !== SYNTHESIS_TASK_TITLE &&
                        onSelectChildTask?.(entry.taskId)
                      }
                      role={entry.taskId && entry.title !== SYNTHESIS_TASK_TITLE ? "button" : undefined}
                    >
                      Created {stripLeadingEmoji(entry.title)}
                    </span>
                    <span className="collab-timeline-spawn-desc">
                      {" "}
                      with the instructions:{" "}
                    <span className="markdown-content markdown-inline">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        components={{
                          p: ({ children }) => <>{replaceEmojisInChildren(children, 12)}</>,
                          li: ({ children }) => <>{replaceEmojisInChildren(children, 12)}</>,
                        }}
                      >
                        {fixUnclosedBold(truncate(normalizeMarkdownForCollab(entry.description), 150))}
                      </ReactMarkdown>
                    </span>
                    </span>
                  </span>
                </div>
              );
            }
            if (entry.kind === "status") {
              const isComplete = entry.id === "status-complete";
              return (
                <div
                  key={entry.id}
                  className={`collab-timeline-status ${isComplete ? "collab-timeline-status-done" : ""}`}
                >
                  {isComplete ? (
                    <Check size={14} strokeWidth={2.5} />
                  ) : entry.id === "status-thinking" || entry.id === "status-synthesize" ? (
                    <Loader2
                      className="collab-summary-spinner"
                      size={14}
                      strokeWidth={2.5}
                    />
                  ) : null}
                  <span>{entry.label}</span>
                </div>
              );
            }
            if (entry.kind === "thought") {
              const err = isErrorLike(entry.thought.content);
              const content = fixUnclosedBold(truncate(normalizeMarkdownForCollab(entry.thought.content), 300));
              return (
                <div
                  key={entry.id}
                  className={`collab-timeline-thought ${err ? "collab-timeline-thought-error" : ""}`}
                  style={{ borderLeftColor: entry.thought.agentColor }}
                >
                  <span
                    className="collab-timeline-thought-agent"
                    style={{ color: entry.thought.agentColor }}
                  >
                    {entry.thought.agentDisplayName}
                  </span>
                  <div className="collab-timeline-thought-content markdown-content">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkBreaks]}
                      components={{
                        p: ({ children }) => <p>{replaceEmojisInChildren(children, 14)}</p>,
                        li: ({ children }) => <li>{replaceEmojisInChildren(children, 14)}</li>,
                      }}
                    >
                      {content}
                    </ReactMarkdown>
                  </div>
                </div>
              );
            }
            return null;
          })}
        </div>
      )}

      {/* Synthesis output — shown in main view (no separate window) */}
      {(() => {
        const synthesisTask = childTasks.find((t) => isSynthesisChildTask(t));
        if (!synthesisTask) return null;
        const synthesisEvents = childEvents.filter((e) => e.taskId === synthesisTask.id);
        const lastAssistant = [...synthesisEvents]
          .reverse()
          .find((e) => getEffectiveTaskEventType(e) === "assistant_message");
        const synthesisOutput =
          synthesisTask.resultSummary?.trim() ||
          (lastAssistant?.payload as { message?: string } | undefined)?.message?.trim();
        if (!synthesisOutput) return null;
        return (
          <div className="collab-summary-synthesis-output">
            <div className="collab-summary-synthesis-heading">Synthesis</div>
            <div className="collab-summary-synthesis-content markdown-content">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                  p: ({ children }) => <p>{replaceEmojisInChildren(children, 14)}</p>,
                  li: ({ children }) => <li>{replaceEmojisInChildren(children, 14)}</li>,
                }}
              >
                {normalizeMarkdownForCollab(synthesisOutput)}
              </ReactMarkdown>
            </div>
          </div>
        );
      })()}

      {/* Live status — spinner, "Agents are working...", Wrap Up — until main task completes */}
      {!mainTaskCompleted && (
        <div className="collab-summary-status collab-summary-status-active">
          {!allDone && <Loader2 className="collab-summary-spinner" size={16} strokeWidth={2.5} />}
          <span>
            {isWrappingUp
              ? "Wrapping up..."
              : allDone
                ? "Finalizing..."
                : phase === "dispatch" && displayItems.length === 0
                  ? "Dispatching agents..."
                  : "Agents are working..."}
          </span>
          {onWrapUp && (
            <button
              type="button"
              className={`collab-summary-wrap-up-btn${isWrappingUp ? " active" : ""}`}
              onClick={onWrapUp}
              disabled={isWrappingUp}
            >
              Wrap Up
            </button>
          )}
        </div>
      )}
    </div>
  );
}
