/**
 * AgentRosterRow
 *
 * One compact transcript line for a burst of sub-agents: a cluster of bot
 * mascots followed by "Anansi, Ares and 2 more started working" (or
 * "… finished" / "… failed" / "… stopped"). Expandable rows reveal whatever
 * the caller passes as children — usually one line per agent.
 */

import type { ReactNode } from "react";
import { AgentGlyph, type AgentGlyphState } from "../AgentGlyph";
import type { AgentGlyphSpec } from "../../utils/agent-glyphs";
import {
  formatAgentRosterLine,
  stripAgentRoleSuffix,
  type AgentRosterState,
} from "../../../shared/subagent-presentation";

export interface AgentRosterEntry {
  id: string;
  name: string;
  glyph: AgentGlyphSpec;
  /** Drives the mascot's face: working, done (happy) or failed. */
  state?: AgentGlyphState;
}

interface AgentRosterRowProps {
  agents: AgentRosterEntry[];
  state: AgentRosterState;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}

/** Glyphs stay readable up to five; beyond that the count carries the rest. */
const MAX_VISIBLE_GLYPHS = 5;

export function AgentRosterRow({
  agents,
  state,
  expandable = false,
  expanded = false,
  onToggle,
  children,
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
        {visibleGlyphs.map((agent) => (
          <AgentGlyph key={agent.id} glyph={agent.glyph} size={20} state={agent.state} />
        ))}
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

  return (
    <div className={`agent-roster agent-roster-${state}${expanded ? " expanded" : ""}`}>
      {expandable ? (
        <button
          type="button"
          className="agent-roster-row expandable"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {content}
        </button>
      ) : (
        <div className="agent-roster-row">{content}</div>
      )}
      {expandable && expanded && children ? (
        <div className="agent-roster-details">{children}</div>
      ) : null}
    </div>
  );
}
