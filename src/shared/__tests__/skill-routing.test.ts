import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CustomSkill } from "../types";
import {
  matchesSkillRoutingQuery,
  rankModelInvocableSkillsForQuery,
  matchesExplicitSkillInvocationPhrase,
  normalizeSkillInvocationText,
} from "../skill-routing";

const skill = (id: string, overrides: Partial<CustomSkill> = {}): CustomSkill => ({
  id,
  name: id,
  description: "Inspect project code and provide practical results.",
  prompt: "Do the requested work.",
  icon: "x",
  category: "Development",
  parameters: [],
  enabled: true,
  ...overrides,
});

describe("production skill routing", () => {
  it.each([
    "Use when the user asks to run atlas-cli for a task.",
    "Use this skill when a user asks to run atlas-cli --help.",
    "Explain when to run atlas-cli for a task.",
    "Describe how to use the atlas-cli skill.",
    "Show me how to run atlas-cli --help.",
  ])("does not mistake a described invocation for an activation: %s", (query) => {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(
      matchesExplicitSkillInvocationPhrase(
        normalizeSkillInvocationText(query),
        "atlas cli",
        escape,
      ),
    ).toBe(false);
  });

  it.each([
    "When you are ready, run atlas-cli --help.",
    "When the user asks, run atlas-cli --help.",
    "Explain when to run the other tool. Then run atlas-cli --help.",
    "Explain when to run the other tool, and run atlas-cli --help.",
    "Use when the user asks to run atlas-cli; run atlas-cli --help now.",
  ])("keeps a direct or later independent activation: %s", (query) => {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(
      matchesExplicitSkillInvocationPhrase(
        normalizeSkillInvocationText(query),
        "atlas cli",
        escape,
      ),
    ).toBe(true);
  });

  it("routes the original coding-agent applicability example without activating Codex CLI", () => {
    const readSkill = (id: string) =>
      JSON.parse(
        readFileSync(new URL(`../../../resources/skills/${id}.json`, import.meta.url), "utf8"),
      ) as CustomSkill;
    const codingAgent = readSkill("coding-agent");
    const codex = readSkill("codex-cli");
    const query =
      "Use when the user asks to run Codex CLI, OpenCode, or Pi Coding Agent via background process for programmatic control.";

    expect(codingAgent.metadata?.routing?.examples?.positive).toContain(query);
    expect(matchesSkillRoutingQuery(codex, query)).toBe(false);
    expect(
      rankModelInvocableSkillsForQuery([codex, codingAgent], query).map(({ skill }) => skill.id),
    ).toEqual(["coding-agent"]);
  });

  it.each([
    ["Use Gemini CLI to summarize this text.", "gemini"],
    ["Run codex-cli --help", "codex-cli"],
    ["Run codex-cli --model example-model --help", "codex-cli"],
    ["Do not use Gemini for file edits. Use Gemini to summarize this text.", "gemini"],
    ["Don't use Gemini for file edits; instead use Gemini CLI to summarize.", "gemini"],
    ['Don\'t use Gemini for file edits. Use Gemini to summarize "the attached text".', "gemini"],
  ])("recognizes a complete command invocation: %s", (query, id) => {
    expect(
      matchesSkillRoutingQuery(
        skill(id, { name: id === "gemini" ? "Gemini" : "Codex CLI" }),
        query,
      ),
    ).toBe(true);
  });

  it.each(["Do not use Gemini CLI to summarize this text.", "Never run Gemini --help"])(
    "does not turn a negated CLI invocation into activation: %s",
    (query) => {
      expect(matchesSkillRoutingQuery(skill("gemini"), query)).toBe(false);
    },
  );

  it.each([
    ["gemini", "Gemini", "Do not use Gemini. The Gemini skill requires a key."],
    [
      "codex-cli",
      "Codex CLI Agent",
      "Do not use the codex-cli skill. The codex-cli skill is unavailable.",
    ],
    [
      "codex-cli",
      "Codex CLI Agent",
      "Do not use codex-cli. The Codex CLI Agent skill requires a key.",
    ],
    ["gemini", "Gemini", "Use Gemini to summarize this text. Actually do not use Gemini."],
    [
      "codex-cli",
      "Codex CLI Agent",
      "Use Codex CLI Agent to summarize this text. Actually do not use codex-cli.",
    ],
  ])("does not let a descriptive mention override an exclusion: %s", (id, name, query) => {
    expect(matchesSkillRoutingQuery(skill(id, { name }), query)).toBe(false);
  });

  it("allows a later affirmative invocation using another alias of the excluded skill", () => {
    expect(
      matchesSkillRoutingQuery(
        skill("codex-cli", { name: "Codex CLI Agent" }),
        "Do not use codex-cli for edits. Use Codex CLI Agent to summarize this text.",
      ),
    ).toBe(true);
  });

  it("does not treat a quoted withdrawal in source text as a later instruction", () => {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(
      matchesExplicitSkillInvocationPhrase(
        normalizeSkillInvocationText('Use Gemini to summarize "Actually do not use Gemini".'),
        "gemini",
        escape,
      ),
    ).toBe(true);
  });

  it("preserves flags while refusing an ambiguous following subcommand for a shorter skill", () => {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(
      matchesExplicitSkillInvocationPhrase(
        normalizeSkillInvocationText("Run render init"),
        "render",
        escape,
      ),
    ).toBe(false);
    expect(
      matchesExplicitSkillInvocationPhrase(
        normalizeSkillInvocationText("Run render --help"),
        "render",
        escape,
      ),
    ).toBe(true);
  });
  it("prefers an explicitly requested skill over an alphabetically earlier saturated match", () => {
    const query =
      "Use the zebra-analysis skill to inspect project code and provide practical results.";
    const requested = skill("zebra-analysis");
    const generic = skill("aardvark-analysis", { description: query });
    const ranked = rankModelInvocableSkillsForQuery([generic, requested], query);
    expect(ranked[0].skill.id).toBe(requested.id);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("preserves stronger relevance when confidence scores reach their maximum", () => {
    const query = "zebra-analysis: inspect project code and provide practical results";
    const requested = skill("zebra-analysis");
    const generic = skill("aardvark-analysis", { description: query });
    const ranked = rankModelInvocableSkillsForQuery([generic, requested], query);
    expect(ranked[0].skill.id).toBe(requested.id);
    expect(ranked.every(({ score }) => score >= 0 && score <= 1)).toBe(true);
  });

  it("matches the complete requested name before a shorter prefix skill", () => {
    const short = skill("zebra");
    const specific = skill("zebra-analysis");
    expect(
      rankModelInvocableSkillsForQuery([short, specific], "Use the zebra-analysis skill.")[0].skill
        .id,
    ).toBe(specific.id);
  });

  it("admits a close supported task paraphrase without opening unrelated keyword-gated tasks", () => {
    const screenshot = skill("capture", {
      metadata: {
        routing: {
          keywords: ["screenshot"],
          examples: {
            positive: ["Capture the full desktop and save it to a file."],
            negative: [],
          },
        },
      },
    });
    expect(
      matchesSkillRoutingQuery(screenshot, "Capture my full desktop and save it to a file."),
    ).toBe(true);
    expect(matchesSkillRoutingQuery(screenshot, "Save the financial report to a file.")).toBe(
      false,
    );
  });

  it.each([
    "Do not use the zebra-analysis skill; use another workflow.",
    "Don't run zebra-analysis for this request.",
    "Never activate the zebra-analysis skill.",
    "Avoid invoking zebra-analysis for this request.",
    "This request is outside zebra analysis scope.",
  ])("does not activate a skill excluded by the request: %s", (query) => {
    expect(matchesSkillRoutingQuery(skill("zebra-analysis"), query)).toBe(false);
  });

  it("does not interpret an exclusion quoted as source content as the user's instruction", () => {
    expect(
      matchesSkillRoutingQuery(
        skill("zebra-analysis"),
        'Use zebra-analysis to analyze the sentence "Do not use zebra-analysis".',
      ),
    ).toBe(true);
  });

  it("rejects an exact negative example without rejecting a nearby supported task", () => {
    const browser = skill("browser", {
      metadata: {
        routing: {
          examples: {
            positive: ["Use browser to inspect an account sign-in page."],
            negative: ["Use browser to defeat the account sign-in check."],
          },
        },
      },
    });
    expect(
      matchesSkillRoutingQuery(browser, "Use browser to defeat the account sign-in check."),
    ).toBe(false);
    expect(
      matchesSkillRoutingQuery(browser, "Use browser to inspect an account sign-in page."),
    ).toBe(true);
  });
});
