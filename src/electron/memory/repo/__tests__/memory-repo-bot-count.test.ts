import { describe, expect, it } from "vitest";
import { botMemoryCount } from "../memory-repo-bots";

const FILE = [
  "- CoWork bot [bot: bot-1; by: user]",
  "- Sends the weekly report every Friday [by: agent]",
  "- Prefers short summaries [by: user]",
  "- Covers for Sam this week [by: agent; until: 2026-10-01]",
].join("\n");

function port(content: string | null, ready = true) {
  return {
    isReady: () => ready,
    botFile: async () => (content === null ? null : "bots/ember.md"),
    readFile: async () => content,
  };
}

describe("botMemoryCount", () => {
  it("counts current entries, without the marker line or expired facts", async () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    await expect(botMemoryCount(port(FILE), "bot-1", now)).resolves.toEqual({
      available: true,
      saved: 2,
    });
  });

  it("reports nothing saved when the bot has no file yet", async () => {
    await expect(botMemoryCount(port(null), "bot-1")).resolves.toEqual({
      available: true,
      saved: 0,
    });
  });

  it("reports the folder unavailable when the service is not ready", async () => {
    await expect(botMemoryCount(port(FILE, false), "bot-1")).resolves.toEqual({
      available: false,
      saved: 0,
    });
    await expect(botMemoryCount(null, "bot-1")).resolves.toEqual({ available: false, saved: 0 });
  });
});
