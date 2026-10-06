import { describe, expect, it } from "vitest";
import { appendLoreEntry, defaultLoreTemplate } from "../lore-file";

const LORE_START = "<!-- cowork:auto:lore:start -->";
const LORE_END = "<!-- cowork:auto:lore:end -->";

describe("appendLoreEntry", () => {
  it("adds a dated milestone under the heading of the default template, without markers", () => {
    const next = appendLoreEntry("", "milestones", "Shipped v1", "2026-10-06");
    expect(next).toContain("## Milestones\n- [2026-10-06] Shipped v1\n");
    expect(next).not.toContain("cowork:auto:lore");
    expect(defaultLoreTemplate()).not.toContain("cowork:auto:lore");
  });

  it("puts a milestone outside an old generated block", () => {
    const current = `# Lore\n\n## Milestones\n${LORE_START}\n- [2026-10-01] task\n${LORE_END}\n\n## Notes\n- n\n`;
    const next = appendLoreEntry(current, "milestones", "Big win", "2026-10-06");
    expect(next).toBe(
      `# Lore\n\n## Milestones\n- [2026-10-06] Big win\n${LORE_START}\n- [2026-10-01] task\n${LORE_END}\n\n## Notes\n- n\n`,
    );
    const inside = next.slice(next.indexOf(LORE_START), next.indexOf(LORE_END));
    expect(inside).not.toContain("Big win");
  });

  it("keeps references and notes undated under their headings and adds a missing heading", () => {
    const current = "# Lore\n\n## Milestones\n- \n\n## Notes\n- \n";
    expect(appendLoreEntry(current, "notes", "Uses pnpm", "2026-10-06")).toBe(
      "# Lore\n\n## Milestones\n- \n\n## Notes\n- Uses pnpm\n- \n",
    );
    expect(appendLoreEntry(current, "references", "The blue deploy", "2026-10-06")).toBe(
      "# Lore\n\n## Milestones\n- \n\n## Notes\n- \n\n## Inside References\n- The blue deploy\n",
    );
  });
});
