/**
 * AgentGlyph
 *
 * The bot mascot that stands for one sub-agent wherever it appears: transcript
 * lifecycle rows, the composer agent lines and the agent sidebar. Which mascot
 * comes from `agent-glyphs.ts`; its face follows the agent's state.
 */

import { BotMascot } from "./bot-mascot/BotMascot";
import type { MascotExpression } from "./bot-mascot/mascot-eyes";
import type { AgentGlyphSpec } from "../utils/agent-glyphs";

export type AgentGlyphState = "idle" | "working" | "done" | "failed";

interface AgentGlyphProps {
  glyph: AgentGlyphSpec;
  size?: number;
  /** Shorthand for `state="working"`. */
  working?: boolean;
  state?: AgentGlyphState;
  className?: string;
  title?: string;
}

const STATE_EXPRESSION: Record<AgentGlyphState, MascotExpression> = {
  idle: "idle",
  working: "working",
  done: "happy",
  failed: "error",
};

export function AgentGlyph({
  glyph,
  size = 18,
  working = false,
  state,
  className,
  title,
}: AgentGlyphProps) {
  const resolvedState: AgentGlyphState = state ?? (working ? "working" : "idle");
  return (
    <span
      className={`agent-glyph${resolvedState === "working" ? " is-working" : ""}${className ? ` ${className}` : ""}`}
      title={title}
    >
      <BotMascot
        mascot={glyph.mascot}
        size={size}
        expression={STATE_EXPRESSION[resolvedState]}
        aria-label={title}
      />
    </span>
  );
}
