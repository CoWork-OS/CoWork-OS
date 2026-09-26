import { describe, expect, it } from "vitest";
import { firstTaskRecovery } from "../first-task-recovery";

describe("first task recovery", () => {
  it("gives different next actions for common failure classes", () => {
    expect(firstTaskRecovery({ status: "failed", error: "HTTP 401" })).toContain("Reconnect");
    expect(firstTaskRecovery({ status: "failed", error: "model not found" })).toContain(
      "available model",
    );
    expect(firstTaskRecovery({ status: "failed", error: "unsupported tool calls" })).toContain(
      "tool-capable",
    );
    expect(firstTaskRecovery({ status: "failed", error: "permission denied" })).toContain(
      "permission",
    );
    expect(firstTaskRecovery({ status: "failed", error: "budget exhausted" })).toContain("budget");
    expect(firstTaskRecovery({ status: "cancelled" })).toContain("cancelled");
    expect(firstTaskRecovery({ status: "interrupted" })).toContain("reconnecting");
  });
});
