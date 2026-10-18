import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor skill use for Hygiene (WP9)", () => {
  function executor() {
    const instance = Object.create(TaskExecutor.prototype) as Any;
    instance.task = { id: "task-1", agentConfig: {} };
    instance.appliedSkills = [];
    instance.emitEvent = vi.fn();
    instance.daemon = { recordLifecycleUse: vi.fn() };
    return instance;
  }

  const application = {
    skillId: "invoice-check",
    skillName: "Invoice check",
    content: "Check each invoice total against the ledger.",
    trigger: "slash",
    reason: "user",
  };

  it("records one use when a skill is applied, and none when the same application is reused", () => {
    const instance = executor();
    expect(instance.applySkillApplication({ ...application })).toBe(true);
    expect(instance.applySkillApplication({ ...application })).toBe(false);
    expect(instance.daemon.recordLifecycleUse).toHaveBeenCalledTimes(1);
    expect(instance.daemon.recordLifecycleUse).toHaveBeenCalledWith("skill", "invoice-check");
  });

  it("records nothing for a blocked application", () => {
    const instance = executor();
    expect(instance.applySkillApplication({ ...application, content: "" })).toBe(false);
    expect(instance.daemon.recordLifecycleUse).not.toHaveBeenCalled();
  });
});
