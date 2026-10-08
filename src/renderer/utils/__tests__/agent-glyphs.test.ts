import { describe, expect, it } from "vitest";

import { BOT_MASCOT_IDS } from "../../../shared/bot-mascots";
import {
  AGENT_GLYPH_MASCOT_ORDER,
  assignAgentGlyphs,
  getAgentGlyphForIndex,
  getAgentGlyphForSeed,
} from "../agent-glyphs";

describe("agent glyphs", () => {
  it("orders every bot mascot exactly once", () => {
    expect([...AGENT_GLYPH_MASCOT_ORDER].sort()).toEqual([...BOT_MASCOT_IDS].sort());
  });

  it("gives the first sixteen agents distinct mascots, then repeats", () => {
    const first = Array.from({ length: 16 }, (_, index) => getAgentGlyphForIndex(index).mascot);
    expect(new Set(first).size).toBe(16);
    expect(getAgentGlyphForIndex(16)).toEqual(getAgentGlyphForIndex(0));
  });

  it("assigns by spawn order regardless of input order", () => {
    const agents = [
      { id: "late", createdAt: 30 },
      { id: "early", createdAt: 10 },
      { id: "middle", createdAt: 20 },
    ];
    const glyphs = assignAgentGlyphs(agents);
    expect(glyphs.get("early")).toEqual(getAgentGlyphForIndex(0));
    expect(glyphs.get("late")).toEqual(getAgentGlyphForIndex(2));
    expect(assignAgentGlyphs([...agents].reverse())).toEqual(glyphs);
  });

  it("is deterministic for seeds and safe for bad indices", () => {
    expect(getAgentGlyphForSeed("team-item-1")).toEqual(getAgentGlyphForSeed("team-item-1"));
    expect(getAgentGlyphForIndex(-3)).toEqual(getAgentGlyphForIndex(0));
  });
});
