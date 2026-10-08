/**
 * Colorful sub-agent glyphs.
 *
 * Every sub-agent in a run gets its own small multi-color mark (an orb, a
 * diamond cluster, a clover, a starburst …) so the transcript, the composer
 * agent lines and the agent sidebar can say who is who at a glance. Glyphs are
 * handed out by spawn order, so the same run always draws the same agent the
 * same way on every surface and no two of its first 64 agents look alike.
 */

export const AGENT_GLYPH_SHAPES = [
  "orb",
  "diamonds",
  "clover",
  "flower",
  "starburst",
  "pinwheel",
  "sparkle",
  "bloom",
] as const;

export type AgentGlyphShape = (typeof AGENT_GLYPH_SHAPES)[number];

export interface AgentGlyphPalette {
  name: string;
  /** Highlight, body and shadow stops of the glyph's gradient. */
  light: string;
  mid: string;
  deep: string;
}

export const AGENT_GLYPH_PALETTES: readonly AgentGlyphPalette[] = [
  { name: "blue", light: "#9fd2ff", mid: "#3b82f6", deep: "#1d4ed8" },
  { name: "violet", light: "#e4ccff", mid: "#a78bfa", deep: "#7c3aed" },
  { name: "coral", light: "#ffd0d0", mid: "#f87171", deep: "#dc2626" },
  { name: "teal", light: "#b4f7ea", mid: "#2dd4bf", deep: "#0d9488" },
  { name: "amber", light: "#ffe9a8", mid: "#fb923c", deep: "#ea580c" },
  { name: "green", light: "#c9f9d6", mid: "#4ade80", deep: "#16a34a" },
  { name: "pink", light: "#fcd7ec", mid: "#f472b6", deep: "#db2777" },
  { name: "cyan", light: "#bff6ff", mid: "#22d3ee", deep: "#0891b2" },
];

export interface AgentGlyphSpec {
  shape: AgentGlyphShape;
  palette: AgentGlyphPalette;
}

/**
 * The glyph for the agent at a given spawn position. Shape cycles every agent
 * and the palette steps by 5 (coprime with 8) plus one per lap of shapes, so
 * neighbours always differ in both and each shape/palette pair is unique for
 * the first 64 positions.
 */
export function getAgentGlyphForIndex(index: number): AgentGlyphSpec {
  const safeIndex = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  const shapeCount = AGENT_GLYPH_SHAPES.length;
  const paletteCount = AGENT_GLYPH_PALETTES.length;
  const lap = Math.floor(safeIndex / shapeCount);
  return {
    shape: AGENT_GLYPH_SHAPES[safeIndex % shapeCount],
    palette: AGENT_GLYPH_PALETTES[(safeIndex * 5 + lap) % paletteCount],
  };
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
  return getAgentGlyphForIndex(hashSeed(seed || "agent") % 64);
}

interface GlyphOrderable {
  id: string;
  createdAt?: number;
}

/**
 * Assign glyphs to a run's agents by spawn order (createdAt, then id) so every
 * surface that sees the same child tasks draws the same glyph for each one.
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
