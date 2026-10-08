import { describe, expect, it } from "vitest";

import { isAskingQuestion } from "../executor-helpers";

describe("isAskingQuestion", () => {
  it("does not treat article prose about product needs as a blocking user question", () => {
    const articleText =
      "15 CoWork OS features you've never touched\n\n" +
      "Most people install CoWork OS and treat it like a smarter assistant. " +
      "The setup needs a few local permissions, and the workspace may require a model provider before advanced features unlock.\n\n" +
      "The point is simple: users often miss the runtime visibility panel, channels, skills, and managed agents.";

    expect(isAskingQuestion(articleText)).toBe(false);
  });

  it("still detects explicit required input prompts", () => {
    expect(
      isAskingQuestion(
        "I cannot continue until you provide the required App Group ID. Reply with the value to proceed.",
      ),
    ).toBe(true);
  });

  it("does not treat a closing list of questions to ask a third party as a question to the user", () => {
    const deliverable = [
      "| Option | Price | Source |",
      "|---|---|---|",
      "| Second Home | €25 + VAT | [site](https://secondhome.io) |",
      "",
      "**Best fit on confirmed information: Second Home Lisboa.**",
      "",
      "### Questions to ask before booking",
      "",
      "- Can you reserve a private, quiet booth for both video calls?",
      "- What accessibility features are available at the entrance and in the restrooms?",
      "",
      "*Source scope: official websites reviewed for the listed details.*",
    ].join("\n");

    expect(isAskingQuestion(deliverable)).toBe(false);
  });

  it("still detects a closing question addressed to the user", () => {
    expect(
      isAskingQuestion(
        "Here are two layouts.\n\n- Option A: grid\n- Option B: list\n\nWhich option do you want me to build?",
      ),
    ).toBe(true);
  });
});
