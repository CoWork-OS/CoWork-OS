import { describe, expect, it } from "vitest";

import { AgentDaemon } from "../daemon";

function resolveCronBudgetProfile(params: {
  title: string;
  prompt: string;
  intent: string;
  complexity?: "low" | "medium" | "high";
}): "balanced" | "strict" | "aggressive" | undefined {
  return (AgentDaemon.prototype as Any).resolveCronBudgetProfile.call({}, {
    title: params.title,
    prompt: params.prompt,
    route: {
      intent: params.intent,
      confidence: 0.95,
      complexity: params.complexity ?? "high",
      domain: "general",
      signals: [],
    },
  });
}

describe("AgentDaemon cron budget profile selection", () => {
  it("uses aggressive for execution research across multiple sources", () => {
    const budgetProfile = resolveCronBudgetProfile({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Execute a 24-hour trend scan across Reddit, X, and tech news, then summarize key developments.",
      intent: "execution",
    });

    expect(budgetProfile).toBe("aggressive");
  });

  it("keeps balanced for non-research execution prompts", () => {
    const budgetProfile = resolveCronBudgetProfile({
      title: "Nightly repo housekeeping",
      prompt: "List stale branches and summarize local workspace disk usage.",
      intent: "execution",
    });

    expect(budgetProfile).toBe("balanced");
  });

  it("keeps balanced for non-execution intents", () => {
    const budgetProfile = resolveCronBudgetProfile({
      title: "Planning sync",
      prompt: "Create a plan for next week priorities.",
      intent: "planning",
      complexity: "medium",
    });

    expect(budgetProfile).toBe("balanced");
  });
});
