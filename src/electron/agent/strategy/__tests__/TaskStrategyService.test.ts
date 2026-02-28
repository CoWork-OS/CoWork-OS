import { describe, expect, it } from "vitest";
import type { IntentRoute } from "../IntentRouter";
import { TaskStrategyService } from "../TaskStrategyService";

function makeRoute(overrides: Partial<IntentRoute> = {}): IntentRoute {
  return {
    intent: "execution",
    confidence: 0.8,
    conversationMode: "task",
    answerFirst: false,
    signals: [],
    complexity: "low",
    domain: "code",
    ...overrides,
  };
}

describe("TaskStrategyService deriveLlmProfile", () => {
  it("returns strong for planning intent", () => {
    const strategy = TaskStrategyService.derive(makeRoute({ intent: "planning" }));
    expect(strategy.llmProfileHint).toBe("strong");
  });

  it("returns strong for verification tasks regardless of confidence", () => {
    const profile = TaskStrategyService.deriveLlmProfile(
      { executionMode: "execute", preflightRequired: false },
      { intent: "execution", isVerificationTask: true },
    );
    expect(profile).toBe("strong");
  });

  it("returns cheap for routine execution tasks", () => {
    const strategy = TaskStrategyService.derive(makeRoute({ intent: "execution" }));
    expect(strategy.llmProfileHint).toBe("cheap");
  });
});

describe("TaskStrategyService applyToAgentConfig", () => {
  it("adds llmProfileHint when no explicit model override exists", () => {
    const strategy = TaskStrategyService.derive(makeRoute({ intent: "planning" }));
    const config = TaskStrategyService.applyToAgentConfig({}, strategy);
    expect(config.llmProfileHint).toBe("strong");
  });

  it("does not keep llmProfileHint when explicit model override is present", () => {
    const strategy = TaskStrategyService.derive(makeRoute({ intent: "planning" }));
    const config = TaskStrategyService.applyToAgentConfig({ modelKey: "gpt-4o" }, strategy);
    expect(config.llmProfileHint).toBeUndefined();
  });
});
