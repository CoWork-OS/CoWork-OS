/**
 * AgentRosterRow
 *
 * One compact transcript line for a burst of dispatched sub-agents: a cluster
 * of role glyphs followed by "Anansi, Ares and 2 more started working". Acts as
 * the header for the dispatched-agents surface, so the full panel can be folded
 * away once the roster line already says who is running.
 */

import { getEmojiIcon } from "../../utils/emoji-icon-map";
import {
  formatAgentRosterLine,
  stripAgentRoleSuffix,
  type AgentRosterState,
} from "../../../shared/subagent-presentation";

export interface AgentRosterEntry {
  id: string;
  name: string;
  icon?: string;
  color?: string;
}

interface AgentRosterRowProps {
  agents: AgentRosterEntry[];
  state: AgentRosterState;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}

/** Glyphs stay readable up to five; beyond that the count carries the rest. */
const MAX_VISIBLE_GLYPHS = 5;

const DEFAULT_AGENT_COLOR = "#6366f1";

export function AgentRosterRow({
  agents,
  state,
  expandable = false,
  expanded = false,
  onToggle,
}: AgentRosterRowProps) {
  if (agents.length === 0) return null;

  const rosterLine = formatAgentRosterLine({
    names: agents.map((agent) => stripAgentRoleSuffix(agent.name)),
    state,
  });
  const visibleGlyphs = agents.slice(0, MAX_VISIBLE_GLYPHS);

  const content = (
    <>
      <span className="agent-roster-glyphs" aria-hidden="true">
        {visibleGlyphs.map((agent) => {
          const Icon = getEmojiIcon(agent.icon || "🤖");
          return (
            <span
              key={agent.id}
              className="agent-roster-glyph"
              style={{ color: agent.color || DEFAULT_AGENT_COLOR }}
            >
              <Icon size={14} strokeWidth={1.75} />
            </span>
          );
        })}
      </span>
      <span className="agent-roster-text">{rosterLine}</span>
      {expandable && (
        <svg
          className={`agent-roster-chevron ${expanded ? "expanded" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      )}
    </>
  );

  if (!expandable) {
    return <div className="agent-roster-row">{content}</div>;
  }

  return (
    <button
      type="button"
      className="agent-roster-row expandable"
      onClick={onToggle}
      aria-expanded={expanded}
    >
      {content}
    </button>
  );
}
