import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: { isInitialized: () => false },
}));

import { GuardrailManager } from "../guardrail-manager";

afterEach(() => {
  vi.restoreAllMocks();
  GuardrailManager.clearCache();
});

describe("cost budget guardrail", () => {
  it("is on by default with a $10 per-task cap", () => {
    expect(GuardrailManager.getDefaults()).toMatchObject({
      costBudgetEnabled: true,
      maxCostPerTask: 10,
    });
    expect(GuardrailManager.isCostBudgetExceeded(10)).toMatchObject({
      exceeded: true,
      limit: 10,
      source: "global",
    });
    expect(GuardrailManager.isCostBudgetExceeded(9.99).exceeded).toBe(false);
  });

  it("always enforces a task's own budgetCost, even when the global cap is off", () => {
    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValue({
      ...GuardrailManager.getDefaults(),
      costBudgetEnabled: false,
    });
    expect(GuardrailManager.isCostBudgetExceeded(2, { taskBudget: 1.5 })).toMatchObject({
      exceeded: true,
      limit: 1.5,
      source: "task",
    });
    expect(GuardrailManager.isCostBudgetExceeded(50).exceeded).toBe(false);
  });

  it("does not stop subscription routes with the global cap, but honours task budgets", () => {
    expect(GuardrailManager.isCostBudgetExceeded(50, { subscriptionBilled: true })).toMatchObject({
      exceeded: false,
      source: "none",
    });
    expect(
      GuardrailManager.isCostBudgetExceeded(3, { subscriptionBilled: true, taskBudget: 2 }),
    ).toMatchObject({ exceeded: true, source: "task" });
  });

  it("enforces a task's own budgetTokens", () => {
    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValue({
      ...GuardrailManager.getDefaults(),
      tokenBudgetEnabled: false,
    });
    expect(GuardrailManager.isTokenBudgetExceeded(5_000, { taskBudget: 4_000 })).toMatchObject({
      exceeded: true,
      limit: 4_000,
      source: "task",
    });
    expect(GuardrailManager.isTokenBudgetExceeded(5_000).exceeded).toBe(false);
  });
});
