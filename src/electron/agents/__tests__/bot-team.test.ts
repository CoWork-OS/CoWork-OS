import { describe, expect, it } from "vitest";
import {
  buildBotTeamContextPrompt,
  hasBotTeamDelegationRequest,
  type BotTeamPromptContext,
} from "../bot-team";

const context: BotTeamPromptContext = {
  teamName: "My chosen team",
  isLead: false,
  peers: [{ id: "user-bot-id", name: "quality+crew", displayName: "Quality Crew" }],
};

describe("configured bot team guidance", () => {
  it("uses configured stable selectors and replies to the actual requester without inventing a lead", () => {
    const prompt = buildBotTeamContextPrompt(context);
    expect(prompt).toContain('bot="user-bot-id"');
    expect(prompt).toContain('handle="quality+crew"');
    expect(prompt).toContain("actual requesting teammate");
    expect(prompt).toContain("[CORRELATED TEAM REPLY]");
    expect(prompt).not.toContain("As the configured team lead");
    expect(buildBotTeamContextPrompt({ ...context, isLead: true })).toContain(
      "As the configured team lead",
    );
  });

  it("keeps an empty configured team empty", () => {
    expect(buildBotTeamContextPrompt({ ...context, peers: [] })).toContain("No other active bot");
  });

  it.each([
    "Ask Quality Crew for a review",
    "Ask @quality+crew to inspect this",
    "Ask user-bot-id for the result",
    "Ask the Quality Crew for evidence",
  ])("recognizes an actual configured selector: %s", (text) => {
    expect(hasBotTeamDelegationRequest(text, context)).toBe(true);
  });

  it.each([
    "Ask qualityxcrew to inspect this",
    "Ask quality+crew-extra for a review",
    "Ask an unrelated bot to help",
    "Describe the team design",
  ])("does not invent peers or interpret a selector as a regular expression: %s", (text) => {
    expect(hasBotTeamDelegationRequest(text, context)).toBe(false);
  });

  it("keeps explicit delegation language independent of bot names", () => {
    expect(hasBotTeamDelegationRequest("Delegate this focused task")).toBe(true);
    expect(hasBotTeamDelegationRequest("Use send_agent_message")).toBe(true);
    expect(hasBotTeamDelegationRequest("Ask Quality Crew", undefined)).toBe(false);
  });
});
