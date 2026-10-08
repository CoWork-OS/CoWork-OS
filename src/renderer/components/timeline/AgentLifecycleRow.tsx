/**
 * AgentLifecycleRow
 *
 * The transcript row for one burst of sub-agents starting or ending. Collapsed
 * it is a single line of glyphs and names; expanded it lists each agent with
 * its status and what it was asked to do (start rows) or what it reported
 * (end rows). Clicking an agent opens it in the agent sidebar.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Task } from "../../../shared/types";
import { buildSpawnInstructionsPreview } from "../../../shared/subagent-presentation";
import { AgentGlyph } from "../AgentGlyph";
import { AgentRosterRow, type AgentRosterEntry } from "./AgentRosterRow";
import { getAgentGlyphForSeed, type AgentGlyphSpec } from "../../utils/agent-glyphs";
import {
  describeAgentStatus,
  getAgentGlyphState,
  resolveAgentDisplayName,
  type AgentLifecycleRow as AgentLifecycleRowModel,
} from "../../utils/agent-lifecycle-rows";

/** Detail lines are one line each; the full text lives in the agent sidebar. */
const DETAIL_PREVIEW_LIMIT = 220;

interface AgentLifecycleRowProps {
  row: AgentLifecycleRowModel;
  tasks: Task[];
  glyphs: Map<string, AgentGlyphSpec>;
  onOpenAgent?: (taskId: string) => void;
  defaultExpanded?: boolean;
}

function getAgentDetail(task: Task, phase: "start" | "end"): string {
  if (phase === "start") {
    return buildSpawnInstructionsPreview(task.prompt, DETAIL_PREVIEW_LIMIT);
  }
  const outcome =
    task.status === "completed"
      ? task.resultSummary
      : typeof task.error === "string" && task.error
        ? task.error
        : task.resultSummary;
  return buildSpawnInstructionsPreview(outcome, DETAIL_PREVIEW_LIMIT);
}

export function AgentLifecycleRow({
  row,
  tasks,
  glyphs,
  onOpenAgent,
  defaultExpanded = false,
}: AgentLifecycleRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (tasks.length === 0) return null;

  const phase = row.state === "working" ? "start" : "end";
  const glyphFor = (task: Task) => glyphs.get(task.id) ?? getAgentGlyphForSeed(task.id);
  const agents: AgentRosterEntry[] = tasks.map((task) => ({
    id: task.id,
    name: resolveAgentDisplayName(task.title),
    glyph: glyphFor(task),
    state: getAgentGlyphState(task.status),
  }));

  return (
    <div className={`agent-lifecycle-event agent-lifecycle-${row.state}`}>
      <AgentRosterRow
        agents={agents}
        state={row.state}
        expandable
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
      >
        <ul className="agent-lifecycle-list">
          {tasks.map((task) => {
            const status = describeAgentStatus(task.status);
            const detail = getAgentDetail(task, phase);
            const body = (
              <>
                <AgentGlyph glyph={glyphFor(task)} size={18} state={getAgentGlyphState(task.status)} />
                <span className="agent-lifecycle-item-name">
                  {resolveAgentDisplayName(task.title)}
                </span>
                <span className={`agent-status-chip agent-status-${status.tone}`}>
                  {status.label}
                </span>
                {detail ? <span className="agent-lifecycle-item-detail">{detail}</span> : null}
                {onOpenAgent ? (
                  <ChevronRight
                    className="agent-lifecycle-item-open"
                    size={13}
                    aria-hidden="true"
                  />
                ) : null}
              </>
            );
            return (
              <li key={task.id}>
                {onOpenAgent ? (
                  <button
                    type="button"
                    className="agent-lifecycle-item"
                    onClick={() => onOpenAgent(task.id)}
                    title={`Open ${resolveAgentDisplayName(task.title)}`}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="agent-lifecycle-item">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </AgentRosterRow>
    </div>
  );
}
