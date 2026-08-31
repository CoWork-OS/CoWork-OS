import { describe, it, expect } from "vitest";
import { isSpawnSubagentsPrompt, parseSpawnAgentCount } from "../spawn-intent-detection";

describe("isSpawnSubagentsPrompt", () => {
  it("returns true for 'spawn subagents'", () => {
    expect(isSpawnSubagentsPrompt("spawn subagents")).toBe(true);
  });

  it("returns true for 'spawn 3 subagents'", () => {
    expect(isSpawnSubagentsPrompt("spawn 3 subagents")).toBe(true);
  });

  it("returns true for 'spawn 3 sub-agents'", () => {
    expect(isSpawnSubagentsPrompt("spawn 3 sub-agents")).toBe(true);
  });

  it("returns true for 'spawn agents'", () => {
    expect(isSpawnSubagentsPrompt("spawn agents")).toBe(true);
  });

  it("returns true for 'spawn sub-agents to explore the repo'", () => {
    expect(isSpawnSubagentsPrompt("spawn sub-agents to explore the repo")).toBe(true);
  });

  it("returns true for 'Spawn 3 subagents to explore the cowork os repo'", () => {
    expect(isSpawnSubagentsPrompt("Spawn 3 subagents to explore the cowork os repo")).toBe(true);
  });

  it("returns true for 'SPAWN SUBAGENTS' (case insensitive)", () => {
    expect(isSpawnSubagentsPrompt("SPAWN SUBAGENTS")).toBe(true);
  });

  it("returns true for 'spawn subagent' (singular)", () => {
    expect(isSpawnSubagentsPrompt("spawn subagent")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isSpawnSubagentsPrompt("")).toBe(false);
  });

  it("returns false for unrelated prompt", () => {
    expect(isSpawnSubagentsPrompt("fix the bug in the login form")).toBe(false);
  });

  it("returns false for 'spawn' alone without agents", () => {
    expect(isSpawnSubagentsPrompt("spawn a process")).toBe(false);
  });
});

describe("parseSpawnAgentCount", () => {
  it("returns 2 for 'spawn 2 subagents'", () => {
    expect(parseSpawnAgentCount("spawn 2 subagents")).toBe(2);
  });

  it("returns 3 for 'spawn 3 subagents to explore'", () => {
    expect(parseSpawnAgentCount("spawn 3 subagents to explore the repo")).toBe(3);
  });

  it("returns 2 for 'spawn 2 agents'", () => {
    expect(parseSpawnAgentCount("spawn 2 agents")).toBe(2);
  });

  it("returns null when no number in prompt", () => {
    expect(parseSpawnAgentCount("spawn subagents")).toBe(null);
    expect(parseSpawnAgentCount("spawn agents")).toBe(null);
  });

  it("returns null for unrelated prompt", () => {
    expect(parseSpawnAgentCount("fix the bug")).toBe(null);
  });
});
