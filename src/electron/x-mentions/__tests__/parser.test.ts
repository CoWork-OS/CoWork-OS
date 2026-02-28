import { describe, expect, it } from "vitest";
import {
  parseMentionTriggerCommand,
  type BirdMentionRecord,
} from "../parser";
import { XMentionTriggerSettings } from "../../../shared/types";

const triggerBase: XMentionTriggerSettings = {
  enabled: true,
  commandPrefix: "do:",
  allowedAuthors: ["tomosman"],
  pollIntervalSec: 60,
  fetchCount: 25,
  workspaceMode: "temporary",
};

const mentionBase: BirdMentionRecord = {
  tweetId: "123",
  conversationId: "999",
  author: "tomosman",
  text: "@agent do: launch a company like this",
  url: "https://x.com/tomosman/status/123",
  timestamp: Date.now(),
  raw: {},
};

describe("X mention trigger parser", () => {
  it("matches prefix case-insensitively", () => {
    const result = parseMentionTriggerCommand(
      {
        ...mentionBase,
        text: "@agent DO: build me a roadmap",
      },
      triggerBase,
    );
    expect(result.accepted).toBe(true);
    expect(result.mention?.command).toBe("build me a roadmap");
  });

  it("supports customizable prefixes", () => {
    const result = parseMentionTriggerCommand(
      {
        ...mentionBase,
        text: "@agent run> draft the deck",
      },
      {
        ...triggerBase,
        commandPrefix: "run>",
      },
    );
    expect(result.accepted).toBe(true);
    expect(result.mention?.command).toBe("draft the deck");
  });

  it("ignores non-matching prefixes", () => {
    const result = parseMentionTriggerCommand(
      {
        ...mentionBase,
        text: "@agent please do this",
      },
      triggerBase,
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("missing-prefix");
  });

  it("does not match prefixes embedded inside other words", () => {
    const result = parseMentionTriggerCommand(
      {
        ...mentionBase,
        text: "@agent the todo: list is long",
      },
      triggerBase,
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("missing-prefix");
  });

  it("ignores empty commands after prefix", () => {
    const result = parseMentionTriggerCommand(
      {
        ...mentionBase,
        text: "@agent do:   ",
      },
      triggerBase,
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("empty-command");
  });

  it("ignores non-allowlisted authors", () => {
    const result = parseMentionTriggerCommand(
      {
        ...mentionBase,
        author: "someoneelse",
      },
      triggerBase,
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("not-allowlisted");
  });

  it("accepts allowlisted authors", () => {
    const result = parseMentionTriggerCommand(mentionBase, triggerBase);
    expect(result.accepted).toBe(true);
    expect(result.mention?.author).toBe("tomosman");
  });
});
