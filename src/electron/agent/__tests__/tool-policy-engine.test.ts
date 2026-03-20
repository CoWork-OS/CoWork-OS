import { describe, expect, it } from "vitest";
import { evaluateToolPolicy } from "../tool-policy-engine";

describe("tool-policy-engine request_user_input gating", () => {
  it("denies all tools in chat mode", () => {
    const decision = evaluateToolPolicy("read_file", {
      executionMode: "chat",
      taskDomain: "auto",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("chat mode");
  });

  it("allows request_user_input in plan mode", () => {
    const decision = evaluateToolPolicy("request_user_input", {
      executionMode: "plan",
      taskDomain: "auto",
    });
    expect(decision.decision).toBe("allow");
  });

  it("denies request_user_input in execute mode", () => {
    const decision = evaluateToolPolicy("request_user_input", {
      executionMode: "execute",
      taskDomain: "auto",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("only available in plan mode");
  });

  it("denies request_user_input in analyze mode", () => {
    const decision = evaluateToolPolicy("request_user_input", {
      executionMode: "analyze",
      taskDomain: "auto",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("only available in plan mode");
  });

  it("allows run_command in general domain when shell is enabled", () => {
    const decision = evaluateToolPolicy("run_command", {
      executionMode: "execute",
      taskDomain: "general",
      shellEnabled: true,
    });
    expect(decision.decision).toBe("allow");
  });

  it("still denies run_command in general domain when shell is disabled", () => {
    const decision = evaluateToolPolicy("run_command", {
      executionMode: "execute",
      taskDomain: "general",
      shellEnabled: false,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain('blocked for the "general" domain');
  });
});
