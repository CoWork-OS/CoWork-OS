import { describe, expect, it } from "vitest";
import { buildWorkspaceScope } from "../workspace-scope";

const connectors = [
  { id: "sf", name: "Salesforce", icon: "☁️", status: "connected", tools: ["mcp_sf_query"] },
  { id: "gh", name: "GitHub", icon: "🐙", status: "connected", tools: ["mcp_gh_issue"] },
  { id: "jira", name: "Jira", icon: "📋", status: "disconnected", tools: ["mcp_jira_find"] },
];
const skills = [
  { id: "deal-review", name: "Deal Review", icon: "⚡" },
  { id: "meeting-prep", name: "Meeting Prep", icon: "⚡" },
  { id: "pdf", name: "PDF", icon: "⚡" },
];

describe("buildWorkspaceScope", () => {
  it("lists every connected connector before anything runs", () => {
    const scope = buildWorkspaceScope({
      connectors,
      skills,
      usedToolNames: new Set(),
      usedSkills: [],
    });
    expect(scope.connectors.map((c) => [c.name, c.used])).toEqual([
      ["GitHub", false],
      ["Salesforce", false],
    ]);
    expect(scope).toMatchObject({ usedSkills: [], otherSkillCount: 3 });
  });

  it("puts used connectors first and counts only unused skills as more", () => {
    const scope = buildWorkspaceScope({
      connectors,
      skills,
      usedToolNames: new Set(["mcp_sf_query"]),
      usedSkills: ["Deal Review"],
    });
    expect(scope.connectors.map((c) => [c.name, c.used])).toEqual([
      ["Salesforce", true],
      ["GitHub", false],
    ]);
    expect(scope).toMatchObject({ usedSkills: ["Deal Review"], otherSkillCount: 2 });
  });

  it("matches a used skill by its id as well as its name", () => {
    const scope = buildWorkspaceScope({
      connectors: [],
      skills,
      usedToolNames: new Set(),
      usedSkills: ["Meeting prep"],
    });
    expect(scope.otherSkillCount).toBe(2);
  });

  it("narrows connectors to the task's tool allow-list", () => {
    const scope = buildWorkspaceScope({
      connectors,
      skills: [],
      usedToolNames: new Set(),
      usedSkills: [],
      allowedTools: ["mcp_gh_issue", "read_file"],
    });
    expect(scope.connectors.map((c) => c.name)).toEqual(["GitHub"]);
  });

  it("keeps connectors turned off for the conversation listed, after the ones still on", () => {
    const scope = buildWorkspaceScope({
      connectors,
      skills: [],
      usedToolNames: new Set(),
      usedSkills: [],
      connectorsOff: ["gh"],
    });
    expect(scope.connectors.map((c) => [c.name, c.off])).toEqual([
      ["Salesforce", false],
      ["GitHub", true],
    ]);
  });
});
