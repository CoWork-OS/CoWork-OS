import { describe, expect, it } from "vitest";

import {
  AGENT_GLYPH_PALETTES,
  AGENT_GLYPH_SHAPES,
  assignAgentGlyphs,
  getAgentGlyphForIndex,
  getAgentGlyphForSeed,
} from "../agent-glyphs";

const key = (index: number) => {
  const glyph = getAgentGlyphForIndex(index);
  return `${glyph.shape}:${glyph.palette.name}`;
};

describe("agent glyphs", () => {
  it("gives the first 64 spawn positions distinct shape/palette pairs", () => {
    const keys = new Set(Array.from({ length: 64 }, (_, index) => key(index)));
    expect(keys.size).toBe(AGENT_GLYPH_SHAPES.length * AGENT_GLYPH_PALETTES.length);
  });

  it("varies both shape and color between neighbouring agents", () => {
    for (let index = 0; index < 63; index += 1) {
      const a = getAgentGlyphForIndex(index);
      const b = getAgentGlyphForIndex(index + 1);
      expect(a.shape).not.toBe(b.shape);
      expect(a.palette.name).not.toBe(b.palette.name);
    }
  });

  it("assigns by spawn order regardless of input order", () => {
    const agents = [
      { id: "late", createdAt: 30 },
      { id: "early", createdAt: 10 },
      { id: "middle", createdAt: 20 },
    ];
    const glyphs = assignAgentGlyphs(agents);
    const reversed = assignAgentGlyphs([...agents].reverse());
    expect(glyphs.get("early")).toEqual(getAgentGlyphForIndex(0));
    expect(glyphs.get("late")).toEqual(getAgentGlyphForIndex(2));
    expect(reversed).toEqual(glyphs);
  });

  it("is deterministic for seeds", () => {
    expect(getAgentGlyphForSeed("team-item-1")).toEqual(getAgentGlyphForSeed("team-item-1"));
    expect(getAgentGlyphForIndex(-3)).toEqual(getAgentGlyphForIndex(0));
  });
});
