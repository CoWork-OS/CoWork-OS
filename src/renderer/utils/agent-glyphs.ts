/**
 * Sub-agent glyphs.
 *
 * Every sub-agent in a run is drawn as one of the CoWork bot mascots so the
 * transcript, the composer agent lines and the agent sidebar can say who is
 * who at a glance. Mascots are handed out by spawn order, so the same run
 * always draws the same agent the same way on every surface, and no two of
 * its first sixteen agents share a mascot.
 */

import { BOT_MASCOT_IDS, type BotMascotId } from "../../shared/bot-mascots";

/**
 * Spawn order of the mascots: neighbours differ in silhouette and color, so a
 * burst of agents reads as distinct characters rather than a palette ramp.
 */
export const AGENT_GLYPH_MASCOT_ORDER: readonly BotMascotId[] = [
  "research",
  "plan",
  "code",
  "create",
  "browse",
  "write",
  "analyze",
  "learn",
  "automate",
  "collaborate",
  "focus",
  "organize",
  "assist",
  "search",
  "reason",
  "everything",
];

export interface AgentGlyphSpec {
  mascot: BotMascotId;
}

/** The mascot for the agent at a given spawn position; repeats after sixteen. */
export function getAgentGlyphForIndex(index: number): AgentGlyphSpec {
  const safeIndex = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  return { mascot: AGENT_GLYPH_MASCOT_ORDER[safeIndex % AGENT_GLYPH_MASCOT_ORDER.length] };
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Glyph for an agent that has no spawn position yet (e.g. a team item not yet dispatched). */
export function getAgentGlyphForSeed(seed: string): AgentGlyphSpec {
  return getAgentGlyphForIndex(hashSeed(seed || "agent") % BOT_MASCOT_IDS.length);
}

interface GlyphOrderable {
  id: string;
  createdAt?: number;
}

/**
 * Assign glyphs to a run's agents by spawn order (createdAt, then id) so every
 * surface that sees the same child tasks draws the same mascot for each one.
 */
export function assignAgentGlyphs(agents: readonly GlyphOrderable[]): Map<string, AgentGlyphSpec> {
  const ordered = [...agents].sort((a, b) => {
    const delta = (a.createdAt ?? 0) - (b.createdAt ?? 0);
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
  const glyphs = new Map<string, AgentGlyphSpec>();
  for (const agent of ordered) {
    if (!glyphs.has(agent.id)) glyphs.set(agent.id, getAgentGlyphForIndex(glyphs.size));
  }
  return glyphs;
}
