import { describe, expect, it } from "vitest";

import { botDeleteConfirmation } from "../BotProfileDialog";

describe("botDeleteConfirmation", () => {
  it("names the bot and says its history is kept", () => {
    expect(botDeleteConfirmation("QA Researcher", 0)).toEqual({
      title: "Delete QA Researcher?",
      message: "Existing conversations and history will be kept.",
      memoryLabel: null,
    });
  });

  it("offers to drop saved memory only when there is some, with the right plural", () => {
    expect(botDeleteConfirmation("QA Researcher", 1).memoryLabel).toBe(
      "Also delete what QA Researcher remembers (1 saved fact). Otherwise it stays in your memory folder.",
    );
    expect(botDeleteConfirmation("QA Researcher", 3).memoryLabel).toContain("(3 saved facts)");
  });
});
