/**
 * CollaborativeSummaryPanel
 *
 * Chronological view of a collaborative or multi-LLM run, in the same voice as
 * the rest of the transcript: the coordinator's plan as prose, one glyph line
 * when the agents start ("Anansi, Ares and 2 more started working") and when
 * they end, each agent's thoughts under its own colorful glyph, then the
 * synthesis.
 */

import { useEffect, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Loader2 } from "lucide-react";
import type { Task, AgentTeamRun, AgentThought, AgentTeamItem } from "../../shared/types";
import type { TaskEvent } from "../../shared/types";
import { isSynthesisChildTask } from "../../shared/synthesis-agent-detection";
import { getEffectiveTaskEventType } from "../utils/task-event-compat";
import { normalizeMarkdownForCollab, fixUnclosedBold } from "../utils/markdown-inline-lists";
import { replaceEmojisInChildren } from "../utils/emoji-replacer";
import { AgentGlyph } from "./AgentGlyph";
import { AgentLifecycleRow } from "./timeline/AgentLifecycleRow";
import { getAgentGlyphForSeed, type AgentGlyphSpec } from "../utils/agent-glyphs";
import {
  buildAgentLifecycleRows,
  resolveAgentDisplayName,
  type AgentLifecycleRow as AgentLifecycleRowModel,
} from "../utils/agent-lifecycle-rows";

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen).trim() + "...";
}

type TimelineEntry =
  | { kind: "strategic"; id: string; content: string; ts: number }
  | { kind: "lifecycle"; id: string; row: AgentLifecycleRowModel; ts: number }
  | { kind: "status"; id: string; label: string; ts: number }
  | { kind: "thought"; id: string; thought: AgentThought; ts: number };

interface CollaborativeSummaryPanelProps {
  collaborativeRun: AgentTeamRun;
  childTasks: Task[];
  childEvents?: TaskEvent[];
  /** Glyph per child task id, shared with the composer lines and agent sidebar. */
  agentGlyphs: Map<string, AgentGlyphSpec>;
  userPrompt?: string;
  onSelectChildTask?: (taskId: string) => void;
  onOpenChildAgentSidebar?: (taskId: string) => void;
  onWrapUp?: () => void;
  isWrappingUp?: boolean;
  /** When true, main task is done — hide Wrap Up */
  mainTaskCompleted?: boolean;
}

export function CollaborativeSummaryPanel({
  collaborativeRun,
  childTasks,
  childEvents = [],
  agentGlyphs,
  userPrompt,
  onSelectChildTask,
  onOpenChildAgentSidebar,
  onWrapUp,
  isWrappingUp,
  mainTaskCompleted = false,
}: CollaborativeSummaryPanelProps) {
  const [teamItems, setTeamItems] = useState<AgentTeamItem[]>([]);
  const [thoughts, setThoughts] = useState<AgentThought[]>([]);
  const [phase, setPhase] = useState<string>(collaborativeRun.phase || "dispatch");

  useEffect(() => {
    window.electronAPI
      .listTeamItems(collaborativeRun.id)
      .then((items: AgentTeamItem[]) => setTeamItems(items))
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
      }) => {
        if (event.run?.id === collaborativeRun.id && event.run?.phase) {
          setPhase(event.run.phase);
        }
        if (
          (event.type === "team_item_spawned" || event.type === "team_item_updated") &&
          event.item &&
          event.runId === collaborativeRun.id
        ) {
          setTeamItems((prev) => {
            const index = prev.findIndex((item) => item.id === event.item!.id);
            if (index === -1) return [...prev, event.item!];
            const next = [...prev];
            next[index] = event.item!;
            return next;
          });
        }
      },
    );
    return () => {
      if (typeof unsubThought === "function") unsubThought();
      if (typeof unsubRun === "function") unsubRun();
    };
  }, [collaborativeRun.id]);

  // The synthesis agent's output is shown below as the run's answer, not as a team member.
  const memberTasks = useMemo(
    () => childTasks.filter((task) => !isSynthesisChildTask(task)),
    [childTasks],
  );
  const childTasksById = useMemo(
    () => new Map(childTasks.map((task) => [task.id, task])),
    [childTasks],
  );
  const plannedCount = Math.max(teamItems.length, memberTasks.length);

  const terminalCount = memberTasks.filter(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
  ).length;
  const workingCount = memberTasks.filter(
    (t) => t.status === "executing" || t.status === "planning" || t.status === "interrupted",
  ).length;
  const allDone = memberTasks.length > 0 && terminalCount === memberTasks.length;

  const timeline = useMemo(() => {
    const entries: TimelineEntry[] = [];
    const runStart = collaborativeRun.startedAt ?? 0;

    // 1. The coordinator's plan, as prose.
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
    } else if (userPrompt && plannedCount > 0) {
      entries.push({
        kind: "strategic",
        id: "strategic-generated",
        content: `Coordinating ${plannedCount} agents to ${truncate(userPrompt, 80)}.`,
        ts: runStart,
      });
    }

    // 2. Glyph lines where agents started and where they ended.
    const lifecycleRows = buildAgentLifecycleRows(memberTasks);
    for (const row of lifecycleRows) {
      entries.push({ kind: "lifecycle", id: row.id, row, ts: row.timestamp });
    }
    const firstStartTs = lifecycleRows[0]?.timestamp ?? runStart;

    // 3. Each agent's thoughts, in order.
    for (const t of thoughts) {
      if (t === strategicThought) continue;
      if (t.phase === "synthesis" || t.content.length > 50) {
        entries.push({ kind: "thought", id: t.id, thought: t, ts: t.createdAt });
      }
    }

    // 4. A live status line while the run is in flight.
    if (phase === "synthesize") {
      entries.push({ kind: "status", id: "status-synthesize", label: "Synthesizing", ts: Date.now() });
    } else if (memberTasks.length === 0 && !mainTaskCompleted) {
      entries.push({
        kind: "status",
        id: "status-dispatch",
        label: plannedCount > 0 ? `Starting ${plannedCount} agents` : "Planning",
        ts: firstStartTs + 1,
      });
    }

    return entries.sort((a, b) => a.ts - b.ts);
  }, [
    thoughts,
    memberTasks,
    plannedCount,
    phase,
    userPrompt,
    mainTaskCompleted,
    collaborativeRun.startedAt,
  ]);

  const isErrorLike = (text: string) =>
    /unable|error|failed|cannot|no team member|not provided/i.test(text);
  const openChildAgent = onOpenChildAgentSidebar ?? onSelectChildTask;

  const glyphForThought = (thought: AgentThought): AgentGlyphSpec => {
    const taskId =
      thought.sourceTaskId ??
      teamItems.find((item) => item.id === thought.teamItemId)?.sourceTaskId ??
      undefined;
    return (
      (taskId ? agentGlyphs.get(taskId) : undefined) ??
      getAgentGlyphForSeed(thought.agentRoleId || thought.agentDisplayName)
    );
  };

  const synthesisOutput = (() => {
    const synthesisTask = childTasks.find((t) => isSynthesisChildTask(t));
    if (!synthesisTask) return null;
    const lastAssistant = [...childEvents]
      .reverse()
      .find(
        (e) => e.taskId === synthesisTask.id && getEffectiveTaskEventType(e) === "assistant_message",
      );
    return (
      synthesisTask.resultSummary?.trim() ||
      (lastAssistant?.payload as { message?: string } | undefined)?.message?.trim() ||
      null
    );
  })();

  const isMultiLlm = collaborativeRun.multiLlmMode === true;
  const agentNoun = isMultiLlm ? "Models" : "Agents";

  return (
    <div className="collaborative-summary-panel">
      <div className="collab-summary-timeline">
        {timeline.map((entry) => {
          if (entry.kind === "strategic") {
            return (
              <div key={entry.id} className="collab-timeline-strategic">
                {entry.content}
              </div>
            );
          }
          if (entry.kind === "lifecycle") {
            const rowTasks = entry.row.taskIds
              .map((taskId) => childTasksById.get(taskId))
              .filter((task): task is Task => Boolean(task));
            return (
              <AgentLifecycleRow
                key={entry.id}
                row={entry.row}
                tasks={rowTasks}
                glyphs={agentGlyphs}
                onOpenAgent={openChildAgent}
              />
            );
          }
          if (entry.kind === "status") {
            return (
              <div key={entry.id} className="collab-timeline-status">
                <Loader2 className="collab-summary-spinner" size={13} strokeWidth={2.5} />
                <span>{entry.label}</span>
              </div>
            );
          }
          const err = isErrorLike(entry.thought.content);
          const content = fixUnclosedBold(
            truncate(normalizeMarkdownForCollab(entry.thought.content), 300),
          );
          const thoughtTaskId = entry.thought.sourceTaskId;
          const canOpen = Boolean(openChildAgent && thoughtTaskId && childTasksById.has(thoughtTaskId));
          return (
            <div
              key={entry.id}
              className={`collab-timeline-thought ${err ? "collab-timeline-thought-error" : ""}`}
            >
              <div className="collab-timeline-thought-head">
                <AgentGlyph glyph={glyphForThought(entry.thought)} size={14} />
                {canOpen ? (
                  <button
                    type="button"
                    className="collab-timeline-thought-agent"
                    onClick={() => openChildAgent?.(thoughtTaskId!)}
                  >
                    {resolveAgentDisplayName(entry.thought.agentDisplayName)}
                  </button>
                ) : (
                  <span className="collab-timeline-thought-agent">
                    {resolveAgentDisplayName(entry.thought.agentDisplayName)}
                  </span>
                )}
              </div>
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
        })}
      </div>

      {synthesisOutput ? (
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
      ) : null}

      {!mainTaskCompleted && (workingCount > 0 || allDone || isWrappingUp) ? (
        <div className="collab-summary-status">
          <Loader2 className="collab-summary-spinner" size={13} strokeWidth={2.5} />
          <span>
            {isWrappingUp
              ? "Wrapping up"
              : allDone
                ? "Finalizing"
                : `${workingCount} of ${memberTasks.length} ${agentNoun.toLowerCase()} working`}
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
      ) : null}
    </div>
  );
}
