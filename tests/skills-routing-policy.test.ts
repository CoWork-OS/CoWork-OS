import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CustomSkill } from "../src/shared/types";
import {
  matchesSkillRoutingQuery,
  rankModelInvocableSkillsForQuery,
} from "../src/shared/skill-routing";

const skillsDirectory = resolve("resources/skills");
const coreSkills = readdirSync(skillsDirectory)
  .filter(
    (name) =>
      name.endsWith(".json") && name !== "build-mode.json" && !name.endsWith(".security.json"),
  )
  .map((name) => JSON.parse(readFileSync(resolve(skillsDirectory, name), "utf8")) as CustomSkill);
const gemini = coreSkills.find((skill) => skill.id === "gemini")!;

describe("bundled skill routing policy", () => {
  it.each([
    "Use Gemini CLI to answer this question in one-shot mode.",
    "Run the Gemini skill to summarize the attached report.",
  ])("routes an explicit Gemini CLI request through the actual catalogue: %s", (query) => {
    expect(matchesSkillRoutingQuery(gemini, query)).toBe(true);
    expect(rankModelInvocableSkillsForQuery(coreSkills, query)[0]?.skill.id).toBe("gemini");
  });

  it.each([
    "Use when the user asks to gemini CLI for one-shot Q&A, summaries, and generation.",
    "Gemini: provide an actionable result.",
    "What is new about Gemini based on the latest Google announcements?",
  ])("keeps descriptive Gemini mentions outside the CLI invocation gate: %s", (query) => {
    expect(matchesSkillRoutingQuery(gemini, query)).toBe(false);
    expect(
      rankModelInvocableSkillsForQuery(coreSkills, query).map(({ skill }) => skill.id),
    ).not.toContain("gemini");
  });

  it("routes changelog work to the actual installed technical-writing pack instead of the retired skill", () => {
    const pack = JSON.parse(
      readFileSync(resolve("resources/plugin-packs/technical-writing/cowork.plugin.json"), "utf8"),
    ) as { name: string; skills: CustomSkill[] };
    expect(coreSkills.some((skill) => skill.id === "create-changelog")).toBe(false);
    expect(coreSkills.some((skill) => skill.id === "tw-changelog")).toBe(false);
    const installedSkills = pack.skills.map((skill) => ({
      ...skill,
      source: "managed" as const,
      metadata: { ...skill.metadata, pluginSource: pack.name },
    }));
    const ranked = rankModelInvocableSkillsForQuery(
      [...coreSkills, ...installedSkills],
      "Create a changelog entry from these merged commits.",
    );
    expect(ranked[0]?.skill.id).toBe("tw-changelog");
    expect(ranked[0]?.skill.metadata?.pluginSource).toBe(pack.name);
    expect(ranked[0]?.skill.prompt).toContain("Keep a Changelog");
  });
});
