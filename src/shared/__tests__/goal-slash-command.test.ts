import { describe, expect, it } from "vitest";
import {
  buildPersistentGoalAgentConfig,
  buildPersistentGoalPrompt,
  parseLeadingGoalSlashCommand,
} from "../goal-slash-command";

describe("goal slash command", () => {
  it("parses a goal objective", () => {
    const parsed = parseLeadingGoalSlashCommand(
      "/goal ship the release --max-continuations=5 --max-turns 300",
    );

    expect(parsed.matched).toBe(true);
    expect(parsed.action).toBe("start");
    expect(parsed.objective).toBe("ship the release");
    expect(parsed.maxAutoContinuations).toBe(5);
    expect(parsed.lifetimeMaxTurns).toBe(300);
  });

  it("parses lifecycle commands", () => {
    expect(parseLeadingGoalSlashCommand("/goal").action).toBe("status");
    expect(parseLeadingGoalSlashCommand("/goal pause").action).toBe("pause");
    expect(parseLeadingGoalSlashCommand("/goal resume").action).toBe("resume");
    expect(parseLeadingGoalSlashCommand("/goal clear").action).toBe("clear");
  });

  it("does not match other slash commands", () => {
    expect(parseLeadingGoalSlashCommand("/goals ship").matched).toBe(false);
    expect(parseLeadingGoalSlashCommand("/schedule daily 9am check").matched).toBe(false);
  });

  it("builds persistent goal runtime defaults", () => {
    const parsed = parseLeadingGoalSlashCommand("/goal publish docs");
    const config = buildPersistentGoalAgentConfig(parsed, 123);

    expect(config.goalMode).toEqual({
      objective: "publish docs",
      status: "active",
      createdAt: 123,
      updatedAt: 123,
    });
    expect(config.deepWorkMode).toBe(true);
    expect(config.autoContinueOnTurnLimit).toBe(true);
    expect(config.maxAutoContinuations).toBe(12);
    expect(config.lifetimeMaxTurns).toBe(1200);
  });

  it("builds an execution prompt with completion markers", () => {
    const prompt = buildPersistentGoalPrompt("finish migration");

    expect(prompt).toContain("Goal: finish migration");
    expect(prompt).toContain("GOAL COMPLETE:");
    expect(prompt).toContain("GOAL BLOCKED:");
  });
});
