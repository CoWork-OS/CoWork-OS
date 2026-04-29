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
});
